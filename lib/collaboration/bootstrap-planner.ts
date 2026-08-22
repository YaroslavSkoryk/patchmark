import {
  canonicalArray,
  canonicalText,
  encodeCanonicalCbor
} from "./canonical-cbor.ts";
import { canonicalProtocolValue } from "./canonical-protocol.ts";
import {
  parseCollaborationBootstrapImportData,
  type BootstrapCommitment,
  type BootstrapSharedComment,
  type BootstrapSharedDocument,
  type BootstrapSharedGroup,
  type BootstrapSharedMetadataEntry,
  type BootstrapIdentityMapping,
  type BootstrapSharedPatch,
  type BootstrapSharedReviewBatch,
  type BootstrapSharedRewriteSession,
  type CollaborationBootstrapImportData,
  type ImportedLegacyVersion
} from "./bootstrap-semantic.ts";
import { capabilitiesForRole } from "./capabilities.ts";
import type { ControlGenesisCore } from "./control.ts";
import { parseControlEventCore } from "./control.ts";
import type { DocumentRevisionCore } from "./content.ts";
import { parseDocumentRevisionCore } from "./content.ts";
import { encodeSha256Base32 } from "./base32.ts";
import {
  adaptLegacyIdentity,
  classifyExistingIdentity,
  parseIdentityMigrationPlan,
  type ExistingIdentityKind,
  type IdentityMigrationDecision,
  type IdentityMigrationPlan,
  type LegacyIdentityAlias,
  type LegacyIdentityAliasScope
} from "./identity-migration.ts";
import type {
  AccessScopeId,
  CommentId,
  ControlEventId,
  ControlStateRootId,
  DeviceId,
  DocumentId,
  DocumentRevisionId,
  EntityIdKind,
  GroupId,
  KeyEpochCommitmentId,
  KeyEpochId,
  MarkdownBlobId,
  MembershipId,
  PatchId,
  PatchVersionId,
  PersonId,
  ProjectId,
  PublicKeyId,
  ReplyId,
  ReviewBatchId,
  RewriteSessionId,
  SemanticEventId,
  SemanticPayloadId
} from "./identities.ts";
import { parseEntityId } from "./identities.ts";
import {
  deriveControlEventCoreIdentity,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity
} from "./preimages.ts";
import {
  deriveControlStateRoot,
  deriveKeyEpochCommitment,
  type ControlStateCommitment
} from "./projection-roots.ts";
import type { SemanticEventCore, SemanticPayloadCore } from "./semantic.ts";
import {
  parseSemanticEventCoreStructure,
  parseSemanticPayloadCore
} from "./semantic.ts";
import { sha256 } from "./sha256.ts";
import {
  BOOTSTRAP_IMPORT_POLICY_VERSION,
  BOOTSTRAP_PLAN_SCHEMA_VERSION,
  BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  DESTINATION_COLLISION_SNAPSHOT_SCHEMA_VERSION,
  DUPLICATION_SOURCE_INVENTORY_SCHEMA_VERSION,
  IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
  INITIAL_REDUCER_VERSION,
  NATIVE_BOOTSTRAP_INPUT_SCHEMA_VERSION,
  SEMANTIC_EVENT_CORE_SCHEMA_VERSION,
  SEMANTIC_PAYLOAD_SCHEMA_VERSION
} from "./versions.ts";
import {
  expectArray,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectNonEmptyString,
  expectString,
  expectUInt64,
  expectZeroUInt64,
  freezeRecord,
  parseSortedUniqueArray,
  parseUniqueArray,
  type UInt64
} from "./validation.ts";
import {
  deriveReviewResponseEvidence,
  parseReviewResponseImportId,
  verifyReviewResponseEvidenceCommitment,
  type ReviewResponseImportId
} from "./review-response-evidence.ts";

export const privateImportFieldNames = [
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
] as const;

export type PrivateImportFieldName = (typeof privateImportFieldNames)[number];

export type NormalizedDuplicationPrivateState = Readonly<
  Record<PrivateImportFieldName, readonly string[]>
>;

export type SourceIdentity = Readonly<{
  source_key: string;
  legacy_id: string | null;
}>;

export type SourceComment = SourceIdentity & Readonly<{
  body: string;
  anchor: string;
  status: "open" | "resolved";
  trash_status: "active" | "trashed";
  tombstone: boolean;
  imported_provenance: string | null;
  imported_history: BootstrapSharedComment["imported_history"];
  replies: readonly (SourceIdentity & Readonly<{
    body: string;
    tombstone: boolean;
    imported_provenance: string | null;
    imported_history: BootstrapSharedComment["replies"][number]["imported_history"];
  }>)[];
}>;

export type SourcePatch = SourceIdentity & Readonly<{
  versions: readonly (SourceIdentity & Readonly<{
    revision_source: "document_current" | null;
    dependency_source_keys: readonly string[];
    decision: "pending" | "accepted" | "rejected";
    target_provenance: string | null;
    imported_provenance: string | null;
  }>)[];
}>;

export type SourceDocument = SourceIdentity & Readonly<{
  markdown_bytes: Uint8Array;
  title: string;
  logical_path: string;
  position: string;
  group_source_key: string | null;
  archive_status: "active" | "archived";
  tombstone: boolean;
  shared_roles: readonly string[];
  comments: readonly SourceComment[];
  patches: readonly SourcePatch[];
  reference_document_source_keys: readonly string[];
}>;

export type NormalizedDuplicationSourceInventory = Readonly<{
  schema_version: typeof DUPLICATION_SOURCE_INVENTORY_SCHEMA_VERSION;
  object_kind: "normalized_duplication_source_inventory";
  source_kind: "legacy_single_document" | "multi_document";
  source_schema_name: string;
  source_schema_version: string;
  source_project: SourceIdentity & Readonly<{ title: string }>;
  project_metadata: readonly BootstrapSharedMetadataEntry[];
  group_order: readonly string[];
  groups: readonly (SourceIdentity & Readonly<{ title: string; position: string }>)[];
  document_order: readonly string[];
  documents: readonly SourceDocument[];
  review_batches: readonly (SourceIdentity & Readonly<{
    document_source_key: string;
    lifecycle: "active" | "responded" | "cancelled";
    response_import_id: ReviewResponseImportId | null;
    imported_provenance: string | null;
  }>)[];
  rewrite_sessions: readonly (SourceIdentity & Readonly<{
    document_source_key: string;
    outcome: "active" | "discarded" | "applied";
    applies_current_revision: boolean;
    imported_provenance: string | null;
  }>)[];
  manual_versions: readonly Readonly<{
    document_source_key: string;
    markdown_bytes: Uint8Array;
    advisory_order: UInt64;
    imported_provenance: string;
  }>[];
  source_validation: Readonly<{
    ownership: "verified";
    persistence_generation: "resolved_clean";
    mixed_source_project_identities: false;
  }>;
  private_state: NormalizedDuplicationPrivateState;
}>;

export const destinationIdentityKinds = [
  "project",
  "group",
  "document",
  "comment",
  "reply",
  "patch",
  "patch-version",
  "review-batch",
  "rewrite-session"
] as const;

export type DestinationIdentityKind = (typeof destinationIdentityKinds)[number];

export type DestinationIdentityAllocation = Readonly<{
  source_key: string;
  identity_kind: DestinationIdentityKind;
  authoritative_id: string;
}>;

export type DestinationCollisionSnapshot = Readonly<{
  schema_version: typeof DESTINATION_COLLISION_SNAPSHOT_SCHEMA_VERSION;
  object_kind: "destination_collision_snapshot";
  registry_generation: string;
  verification_scope: "all_preallocated_destination_identities";
  checked_authoritative_ids: readonly string[];
  occupied_authoritative_ids: readonly string[];
  trusted_legacy_ids_verified_unique: readonly string[];
}>;

export type NativeBootstrapDocumentInput = Readonly<{
  document_id: DocumentId;
  markdown_bytes: Uint8Array;
  title: string;
  logical_path: string;
  position: string;
  group_id: GroupId | null;
  archive_status: "active" | "archived";
  tombstone: boolean;
  shared_roles: readonly string[];
  comments: readonly BootstrapSharedComment[];
  patches: readonly Readonly<{
    patch_id: PatchId;
    versions: readonly Readonly<{
      patch_version_id: PatchVersionId;
      revision_source: "document_current" | null;
      dependency_patch_version_ids: readonly PatchVersionId[];
      decision: "pending" | "accepted" | "rejected";
      target_provenance: string | null;
      imported_provenance: null;
    }>[];
  }>[];
  reference_document_ids: readonly DocumentId[];
}>;

export type NativeBootstrapReviewInput = Readonly<{
  review_batch_id: ReviewBatchId;
  lifecycle: "active" | "responded" | "cancelled";
  response_import_id: ReviewResponseImportId | null;
  imported_provenance: null;
}>;

export type NativeCollaborationBootstrapInput = Readonly<{
  schema_version: typeof NATIVE_BOOTSTRAP_INPUT_SCHEMA_VERSION;
  object_kind: "native_collaboration_bootstrap_input";
  protocol_version: typeof COLLABORATION_PROTOCOL_VERSION;
  reducer_version: typeof INITIAL_REDUCER_VERSION;
  project_id: ProjectId;
  project_title: string;
  project_metadata: readonly BootstrapSharedMetadataEntry[];
  owner_person_id: PersonId;
  owner_membership_id: MembershipId;
  owner_access_scope_id: AccessScopeId;
  owner_device_id: DeviceId;
  owner_device_signing_key_id: PublicKeyId;
  offline_root_public_key_id: PublicKeyId;
  initial_key_epoch_number: UInt64;
  initial_key_epoch_id: KeyEpochId;
  initial_key_epoch_public_commitment_bytes: Uint8Array;
  initial_merge_policy: "manual" | "auto_safe";
  group_order: readonly GroupId[];
  groups: readonly BootstrapSharedGroup[];
  document_order: readonly DocumentId[];
  documents: readonly NativeBootstrapDocumentInput[];
  initial_review_batches: readonly NativeBootstrapReviewInput[];
  initial_rewrite_sessions: readonly Readonly<{
    rewrite_session_id: RewriteSessionId;
    document_id: DocumentId;
    outcome: "active" | "discarded" | "applied";
    applies_current_revision: boolean;
    imported_provenance: null;
  }>[];
}>;

export type DuplicateCollaborationBootstrapInput = Readonly<{
  schema_version: 1;
  object_kind: "duplicate_collaboration_bootstrap_input";
  protocol_version: typeof COLLABORATION_PROTOCOL_VERSION;
  reducer_version: typeof INITIAL_REDUCER_VERSION;
  destination_project_id: ProjectId;
  owner_person_id: PersonId;
  owner_membership_id: MembershipId;
  owner_access_scope_id: AccessScopeId;
  owner_device_id: DeviceId;
  owner_device_signing_key_id: PublicKeyId;
  offline_root_public_key_id: PublicKeyId;
  initial_key_epoch_number: UInt64;
  initial_key_epoch_id: KeyEpochId;
  initial_key_epoch_public_commitment_bytes: Uint8Array;
  initial_merge_policy: "manual" | "auto_safe";
  source_inventory: NormalizedDuplicationSourceInventory;
  destination_identity_allocations: readonly DestinationIdentityAllocation[];
  collision_snapshot: DestinationCollisionSnapshot;
}>;

export type PlannedMarkdownObject = Readonly<{
  object_role: "current_document" | "imported_legacy_version";
  project_id: ProjectId;
  document_id: DocumentId;
  markdown_blob_id: MarkdownBlobId;
  exact_bytes: Uint8Array;
}>;

export type PlannedRevisionObject = Readonly<{
  object_role: "baseline_revision";
  document_id: DocumentId;
  revision_id: DocumentRevisionId;
  core: DocumentRevisionCore;
}>;

export type PlannedIdentityMapping = BootstrapIdentityMapping;

export const bootstrapConstructionStages = [
  "validate_frozen_plan_and_source",
  "establish_isolated_destination",
  "persist_markdown_blobs",
  "persist_baseline_revisions",
  "persist_imported_evidence",
  "calculate_control_state",
  "create_control_genesis",
  "persist_semantic_bootstrap_payload",
  "append_semantic_bootstrap_event",
  "reconstruct_accepted_events",
  "project_shared_state",
  "verify_projection_equivalence",
  "prepare_checkpoint",
  "append_checkpoint",
  "verify_full_history_checkpoint",
  "persist_state_blob",
  "persist_snapshot_and_boundary",
  "reopen_and_verify",
  "write_complete_marker"
] as const;

export type BootstrapConstructionStage = (typeof bootstrapConstructionStages)[number];

export type CollaborationBootstrapPlan = Readonly<{
  schema_version: typeof BOOTSTRAP_PLAN_SCHEMA_VERSION;
  object_kind: "collaboration_bootstrap_plan";
  authority: "none";
  bootstrap_kind: "native" | "duplicate_current_state";
  protocol_version: typeof COLLABORATION_PROTOCOL_VERSION;
  reducer_version: typeof INITIAL_REDUCER_VERSION;
  destination_project_id: ProjectId;
  plan_commitment: BootstrapCommitment;
  source_inventory_commitment: BootstrapCommitment | null;
  identity_map_commitment: BootstrapCommitment;
  identity_mappings: readonly PlannedIdentityMapping[];
  excluded_private_fields: readonly PrivateImportFieldName[];
  warnings: readonly string[];
  owner_person_id: PersonId;
  owner_device_id: DeviceId;
  owner_device_signing_key_id: PublicKeyId;
  initial_key_epoch_id: KeyEpochId;
  initial_key_epoch_commitment: KeyEpochCommitmentId;
  initial_merge_policy: "manual" | "auto_safe";
  control_state: ControlStateCommitment;
  control_state_root: ControlStateRootId;
  control_genesis_core: ControlGenesisCore;
  expected_control_event_id: ControlEventId;
  markdown_objects: readonly PlannedMarkdownObject[];
  revision_objects: readonly PlannedRevisionObject[];
  semantic_payload_core: SemanticPayloadCore;
  expected_semantic_payload_id: SemanticPayloadId;
  semantic_event_core: SemanticEventCore;
  expected_semantic_event_id: SemanticEventId;
  expected_shared_state: CollaborationBootstrapImportData;
  construction_order: typeof bootstrapConstructionStages;
  final_verification_requirements: readonly string[];
  destination_label: "local_collaboration_foundation_only";
  unavailable_capabilities: readonly [
    "invitations",
    "export_exchange",
    "synchronization",
    "production_key_custody",
    "secure_multi_user_claim"
  ];
}>;

type ParsedBootstrapAuthority = Readonly<{
  project_id: ProjectId;
  owner_person_id: PersonId;
  owner_membership_id: MembershipId;
  owner_access_scope_id: AccessScopeId;
  owner_device_id: DeviceId;
  owner_device_signing_key_id: PublicKeyId;
  offline_root_public_key_id: PublicKeyId;
  initial_key_epoch_number: UInt64;
  initial_key_epoch_id: KeyEpochId;
  initial_key_epoch_public_commitment_bytes: Uint8Array;
  initial_merge_policy: "manual" | "auto_safe";
}>;

const finalVerificationRequirements = Object.freeze([
  "source_commitment_matches",
  "control_genesis_accepted",
  "semantic_bootstrap_event_accepted",
  "projection_equivalence_exact",
  "no_unexpected_shared_entities",
  "full_history_checkpoint_verified",
  "state_blob_verified",
  "snapshot_boundary_manifest_verified",
  "reopen_roots_match",
  "complete_marker_written_last"
]);

const unavailableCapabilities = Object.freeze([
  "invitations",
  "export_exchange",
  "synchronization",
  "production_key_custody",
  "secure_multi_user_claim"
]) as CollaborationBootstrapPlan["unavailable_capabilities"];

export async function planNativeCollaborationBootstrap(
  inputValue: NativeCollaborationBootstrapInput | unknown
): Promise<CollaborationBootstrapPlan> {
  const input = parseNativeCollaborationBootstrapInput(inputValue);
  const authority = bootstrapAuthority(input.project_id, input);
  const currentObjects = await planNativeCurrentObjects(input);
  const reviewBatches = await Promise.all(
    input.initial_review_batches.map((review) => buildBootstrapReviewBatch(
      input.project_id,
      review.review_batch_id,
      review.lifecycle,
      review.response_import_id,
      review.imported_provenance,
      Object.freeze([])
    ))
  );
  const identityMappings = Object.freeze([
    nativeMapping("project", "project", input.project_id),
    ...input.groups.map((group) => nativeMapping(group.group_id, "group", group.group_id)),
    ...input.documents.flatMap((document) => nativeDocumentMappings(document)),
    ...input.initial_review_batches.map((review) => nativeMapping(
      review.review_batch_id,
      "review-batch",
      review.review_batch_id
    )),
    ...input.initial_rewrite_sessions.map((rewrite) => nativeMapping(
      rewrite.rewrite_session_id,
      "rewrite-session",
      rewrite.rewrite_session_id
    ))
  ].sort(mappingCompare));
  const sharedState = parseCollaborationBootstrapImportData({
    schema_version: BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION,
    import_policy_version: BOOTSTRAP_IMPORT_POLICY_VERSION,
    bootstrap_kind: "native",
    earlier_collaboration_history: "does_not_exist",
    source_inventory_commitment: null,
    project_title: input.project_title,
    project_metadata: input.project_metadata,
    group_order: input.group_order,
    groups: input.groups,
    document_order: input.document_order,
    documents: currentObjects.documents,
    review_batches: Object.freeze(reviewBatches.sort((a, b) => compare(
      a.review_batch_id,
      b.review_batch_id
    ))),
    rewrite_sessions: input.initial_rewrite_sessions.map((session) => ({
      rewrite_session_id: session.rewrite_session_id,
      document_id: session.document_id,
      outcome: session.outcome,
      applied_revision_ids: session.applies_current_revision
        ? [requireBaselineRevision(currentObjects.documents, session.document_id)]
        : [],
      imported_provenance: null
    })),
    identity_migration_plan: null,
    identity_mappings: identityMappings,
    legacy_aliases: [],
    imported_legacy_versions: []
  }, input.project_id);
  return buildPlan({
    authority,
    bootstrap_kind: "native",
    source_inventory_commitment: null,
    identity_mappings: identityMappings,
    excluded_private_fields: Object.freeze([]),
    warnings: Object.freeze([]),
    markdown_objects: currentObjects.markdownObjects,
    revision_objects: currentObjects.revisionObjects,
    shared_state: sharedState
  });
}

export async function planDuplicateAsCollaborationProject(
  inputValue: DuplicateCollaborationBootstrapInput | unknown
): Promise<CollaborationBootstrapPlan> {
  const input = parseDuplicateCollaborationBootstrapInput(inputValue);
  const inventory = input.source_inventory;
  const sourceCommitment = await deriveSourceInventoryCommitment(inventory);
  const authority = bootstrapAuthority(input.destination_project_id, input);
  const allocations = new Map(
    input.destination_identity_allocations.map((entry) => [entry.source_key, entry])
  );
  const identityResult = buildDuplicationIdentityPlan(
    inventory,
    allocations,
    input.collision_snapshot,
    input.destination_project_id
  );
  const currentObjects = await planDuplicationObjects(
    input.destination_project_id,
    inventory,
    allocations
  );
  const sharedState = await duplicationSharedState(
    input.destination_project_id,
    inventory,
    allocations,
    currentObjects,
    sourceCommitment,
    identityResult.migrationPlan,
    identityResult.mappings,
    identityResult.aliases
  );
  return buildPlan({
    authority,
    bootstrap_kind: "duplicate_current_state",
    source_inventory_commitment: sourceCommitment,
    identity_mappings: identityResult.mappings,
    excluded_private_fields: Object.freeze(
      privateImportFieldNames.filter(
        (field) => inventory.private_state[field].length > 0
      )
    ),
    warnings: identityResult.warnings,
    markdown_objects: currentObjects.markdownObjects,
    revision_objects: currentObjects.revisionObjects,
    shared_state: sharedState
  });
}

export function parseNativeCollaborationBootstrapInput(
  value: unknown
): NativeCollaborationBootstrapInput {
  const record = expectExactRecord(value, "native collaboration bootstrap input", [
    "schema_version",
    "object_kind",
    "protocol_version",
    "reducer_version",
    "project_id",
    "project_title",
    "project_metadata",
    "owner_person_id",
    "owner_membership_id",
    "owner_access_scope_id",
    "owner_device_id",
    "owner_device_signing_key_id",
    "offline_root_public_key_id",
    "initial_key_epoch_number",
    "initial_key_epoch_id",
    "initial_key_epoch_public_commitment_bytes",
    "initial_merge_policy",
    "group_order",
    "groups",
    "document_order",
    "documents",
    "initial_review_batches",
    "initial_rewrite_sessions"
  ]);
  expectLiteral(
    record.schema_version,
    NATIVE_BOOTSTRAP_INPUT_SCHEMA_VERSION,
    "native bootstrap input version"
  );
  expectLiteral(
    record.object_kind,
    "native_collaboration_bootstrap_input",
    "native bootstrap input kind"
  );
  parseProtocolVersions(record);
  const groups = parseUniqueArray(
    record.groups,
    "native bootstrap groups",
    parseNativeGroup,
    (entry) => entry.group_id,
    { allowEmpty: true, requireSorted: true }
  );
  const groupOrder = parseAuthoritativeOrder(
    record.group_order,
    "group",
    groups.map((entry) => entry.group_id),
    "native group order"
  );
  const documents = parseUniqueArray(
    record.documents,
    "native bootstrap documents",
    parseNativeDocument,
    (entry) => entry.document_id,
    { allowEmpty: true, requireSorted: true }
  );
  const documentOrder = parseAuthoritativeOrder(
    record.document_order,
    "document",
    documents.map((entry) => entry.document_id),
    "native document order"
  );
  validateNativeRelationships(groups, documents);
  const reviews = parseUniqueArray(
    record.initial_review_batches,
    "native review batches",
    parseNativeReview,
    (entry) => entry.review_batch_id,
    { allowEmpty: true, requireSorted: true }
  );
  const rewrites = parseUniqueArray(
    record.initial_rewrite_sessions,
    "native rewrite sessions",
    parseNativeRewrite,
    (entry) => entry.rewrite_session_id,
    { allowEmpty: true, requireSorted: true }
  );
  const documentIds = new Set(documents.map((entry) => entry.document_id));
  for (const rewrite of rewrites) {
    if (!documentIds.has(rewrite.document_id)) {
      throw new Error("Native rewrite belongs to an unregistered document.");
    }
  }
  return freezeRecord({
    schema_version: NATIVE_BOOTSTRAP_INPUT_SCHEMA_VERSION,
    object_kind: "native_collaboration_bootstrap_input" as const,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    reducer_version: INITIAL_REDUCER_VERSION,
    project_id: parseEntityId("project", record.project_id),
    project_title: expectString(record.project_title, "native project title"),
    project_metadata: parseMetadata(record.project_metadata),
    ...parseAuthorityFields(record),
    group_order: groupOrder,
    groups,
    document_order: documentOrder,
    documents,
    initial_review_batches: reviews,
    initial_rewrite_sessions: rewrites
  });
}

export function parseNormalizedDuplicationSourceInventory(
  value: unknown
): NormalizedDuplicationSourceInventory {
  const record = expectExactRecord(value, "normalized duplication source inventory", [
    "schema_version",
    "object_kind",
    "source_kind",
    "source_schema_name",
    "source_schema_version",
    "source_project",
    "project_metadata",
    "group_order",
    "groups",
    "document_order",
    "documents",
    "review_batches",
    "rewrite_sessions",
    "manual_versions",
    "source_validation",
    "private_state"
  ]);
  expectLiteral(
    record.schema_version,
    DUPLICATION_SOURCE_INVENTORY_SCHEMA_VERSION,
    "duplication source inventory version"
  );
  expectLiteral(
    record.object_kind,
    "normalized_duplication_source_inventory",
    "duplication source inventory kind"
  );
  const sourceProjectRecord = expectExactRecord(
    record.source_project,
    "duplication source project",
    ["source_key", "legacy_id", "title"]
  );
  const sourceProject = freezeRecord({
    ...parseSourceIdentity(sourceProjectRecord, "source project"),
    title: expectString(sourceProjectRecord.title, "source project title")
  });
  if (sourceProject.source_key !== "project") {
    throw new Error("Normalized source project key must be exactly project.");
  }
  const groups = parseUniqueArray(
    record.groups,
    "source groups",
    parseSourceGroup,
    (entry) => entry.source_key,
    { allowEmpty: true, requireSorted: true }
  );
  const documents = parseUniqueArray(
    record.documents,
    "source documents",
    parseSourceDocument,
    (entry) => entry.source_key,
    { allowEmpty: false, requireSorted: true }
  );
  const groupOrder = parseSourceOrder(
    record.group_order,
    groups.map((entry) => entry.source_key),
    "source group order"
  );
  const documentOrder = parseSourceOrder(
    record.document_order,
    documents.map((entry) => entry.source_key),
    "source document order"
  );
  const reviews = parseUniqueArray(
    record.review_batches,
    "source review batches",
    parseSourceReview,
    (entry) => entry.source_key,
    { allowEmpty: true, requireSorted: true }
  );
  const rewrites = parseUniqueArray(
    record.rewrite_sessions,
    "source rewrite sessions",
    parseSourceRewrite,
    (entry) => entry.source_key,
    { allowEmpty: true, requireSorted: true }
  );
  const manualVersions = parseUniqueArray(
    record.manual_versions,
    "source manual versions",
    parseSourceManualVersion,
    (entry) => `${entry.document_source_key}\u0000${entry.advisory_order.toString().padStart(20, "0")}`,
    { allowEmpty: true, requireSorted: true }
  );
  validateSourceRelationships(groups, documents, reviews, rewrites, manualVersions);
  const validation = expectExactRecord(record.source_validation, "source validation", [
    "ownership",
    "persistence_generation",
    "mixed_source_project_identities"
  ]);
  expectLiteral(validation.ownership, "verified", "source ownership validation");
  expectLiteral(
    validation.persistence_generation,
    "resolved_clean",
    "source persistence generation"
  );
  expectLiteral(
    validation.mixed_source_project_identities,
    false,
    "mixed source project identities"
  );
  const inventory = freezeRecord({
    schema_version: DUPLICATION_SOURCE_INVENTORY_SCHEMA_VERSION,
    object_kind: "normalized_duplication_source_inventory" as const,
    source_kind: expectEnum(
      record.source_kind,
      ["legacy_single_document", "multi_document"] as const,
      "duplication source kind"
    ),
    source_schema_name: expectNonEmptyString(
      record.source_schema_name,
      "source schema name"
    ),
    source_schema_version: expectNonEmptyString(
      record.source_schema_version,
      "source schema version"
    ),
    source_project: sourceProject,
    project_metadata: parseMetadata(record.project_metadata),
    group_order: groupOrder,
    groups,
    document_order: documentOrder,
    documents,
    review_batches: reviews,
    rewrite_sessions: rewrites,
    manual_versions: manualVersions,
    source_validation: freezeRecord({
      ownership: "verified" as const,
      persistence_generation: "resolved_clean" as const,
      mixed_source_project_identities: false as const
    }),
    private_state: parsePrivateState(record.private_state)
  });
  validateSourceKind(inventory);
  return inventory;
}

export async function deriveSourceInventoryCommitment(
  value: NormalizedDuplicationSourceInventory | unknown
): Promise<BootstrapCommitment> {
  const inventory = parseNormalizedDuplicationSourceInventory(value);
  const sharedSnapshot = {
    schema_version: inventory.schema_version,
    object_kind: inventory.object_kind,
    source_kind: inventory.source_kind,
    source_schema_name: inventory.source_schema_name,
    source_schema_version: inventory.source_schema_version,
    source_project: inventory.source_project,
    project_metadata: inventory.project_metadata,
    group_order: inventory.group_order,
    groups: inventory.groups,
    document_order: inventory.document_order,
    documents: inventory.documents,
    review_batches: inventory.review_batches,
    rewrite_sessions: inventory.rewrite_sessions,
    manual_versions: inventory.manual_versions,
    source_validation: inventory.source_validation
  };
  return contentCommitment("source", sharedSnapshot);
}

export function parseDestinationCollisionSnapshot(
  value: unknown
): DestinationCollisionSnapshot {
  const record = expectExactRecord(value, "destination collision snapshot", [
    "schema_version",
    "object_kind",
    "registry_generation",
    "verification_scope",
    "checked_authoritative_ids",
    "occupied_authoritative_ids",
    "trusted_legacy_ids_verified_unique"
  ]);
  expectLiteral(
    record.schema_version,
    DESTINATION_COLLISION_SNAPSHOT_SCHEMA_VERSION,
    "destination collision snapshot version"
  );
  expectLiteral(
    record.object_kind,
    "destination_collision_snapshot",
    "destination collision snapshot kind"
  );
  expectLiteral(
    record.verification_scope,
    "all_preallocated_destination_identities",
    "destination collision verification scope"
  );
  const checked = parseSortedStrings(
    record.checked_authoritative_ids,
    "checked destination identities"
  );
  const occupied = parseSortedStrings(
    record.occupied_authoritative_ids,
    "occupied destination identities"
  );
  for (const id of occupied) {
    if (!checked.includes(id)) {
      throw new Error("Occupied destination identities must be part of the checked set.");
    }
  }
  return freezeRecord({
    schema_version: DESTINATION_COLLISION_SNAPSHOT_SCHEMA_VERSION,
    object_kind: "destination_collision_snapshot" as const,
    registry_generation: expectNonEmptyString(
      record.registry_generation,
      "destination registry generation"
    ),
    verification_scope: "all_preallocated_destination_identities" as const,
    checked_authoritative_ids: checked,
    occupied_authoritative_ids: occupied,
    trusted_legacy_ids_verified_unique: parseSortedStrings(
      record.trusted_legacy_ids_verified_unique,
      "trusted unique legacy identities"
    )
  });
}

export function parseCollaborationBootstrapPlan(
  value: unknown
): CollaborationBootstrapPlan {
  const record = expectExactRecord(value, "collaboration bootstrap plan", [
    "schema_version",
    "object_kind",
    "authority",
    "bootstrap_kind",
    "protocol_version",
    "reducer_version",
    "destination_project_id",
    "plan_commitment",
    "source_inventory_commitment",
    "identity_map_commitment",
    "identity_mappings",
    "excluded_private_fields",
    "warnings",
    "owner_person_id",
    "owner_device_id",
    "owner_device_signing_key_id",
    "initial_key_epoch_id",
    "initial_key_epoch_commitment",
    "initial_merge_policy",
    "control_state",
    "control_state_root",
    "control_genesis_core",
    "expected_control_event_id",
    "markdown_objects",
    "revision_objects",
    "semantic_payload_core",
    "expected_semantic_payload_id",
    "semantic_event_core",
    "expected_semantic_event_id",
    "expected_shared_state",
    "construction_order",
    "final_verification_requirements",
    "destination_label",
    "unavailable_capabilities"
  ]);
  expectLiteral(record.schema_version, BOOTSTRAP_PLAN_SCHEMA_VERSION, "bootstrap plan version");
  expectLiteral(record.object_kind, "collaboration_bootstrap_plan", "bootstrap plan kind");
  expectLiteral(record.authority, "none", "bootstrap plan authority");
  const projectId = parseEntityId("project", record.destination_project_id);
  const payload = parseSemanticPayloadCore(record.semantic_payload_core);
  if (
    payload.project_id !== projectId ||
    payload.semantic_kind !== "collaboration_bootstrap_import"
  ) {
    throw new Error("Bootstrap plan semantic payload is not its destination import boundary.");
  }
  const event = parseSemanticEventCoreStructure(record.semantic_event_core);
  if (
    event.semantic_kind !== payload.semantic_kind ||
    event.semantic_payload_id !== record.expected_semantic_payload_id
  ) {
    throw new Error("Bootstrap semantic event does not bind its exact payload.");
  }
  const control = parseControlEventCore(record.control_genesis_core);
  if (control.control_kind !== "genesis" || control.project_id !== projectId) {
    throw new Error("Bootstrap plan requires the exact destination control genesis.");
  }
  assertExactArray(record.construction_order, bootstrapConstructionStages, "bootstrap construction order");
  assertExactArray(
    record.final_verification_requirements,
    finalVerificationRequirements,
    "bootstrap final verification requirements"
  );
  assertExactArray(record.unavailable_capabilities, unavailableCapabilities, "bootstrap unavailable capabilities");
  const plan = value as CollaborationBootstrapPlan;
  if (event.project_id !== projectId) throw new Error("Bootstrap semantic event project mismatch.");
  return plan;
}

export async function verifyCollaborationBootstrapPlan(
  value: CollaborationBootstrapPlan | unknown
): Promise<CollaborationBootstrapPlan> {
  const plan = parseCollaborationBootstrapPlan(value);
  const payloadIdentity = await deriveSemanticPayloadIdentity(plan.semantic_payload_core);
  const eventIdentity = await deriveSemanticEventCoreIdentity(plan.semantic_event_core);
  const controlIdentity = await deriveControlEventCoreIdentity(plan.control_genesis_core);
  const controlRoot = await deriveControlStateRoot(plan.control_state);
  if (
    payloadIdentity.id !== plan.expected_semantic_payload_id ||
    eventIdentity.id !== plan.expected_semantic_event_id ||
    controlIdentity.id !== plan.expected_control_event_id ||
    controlRoot.id !== plan.control_state_root
  ) {
    throw new Error("Bootstrap plan derived identity or control-root commitment mismatch.");
  }
  for (const object of plan.markdown_objects) {
    const identity = await deriveMarkdownBlobIdentity(
      object.project_id,
      object.exact_bytes
    );
    if (identity.id !== object.markdown_blob_id) {
      throw new Error("Bootstrap Markdown object identity mismatch.");
    }
  }
  for (const object of plan.revision_objects) {
    const identity = await deriveDocumentRevisionIdentity(object.core);
    if (identity.id !== object.revision_id) {
      throw new Error("Bootstrap revision object identity mismatch.");
    }
  }
  for (const review of plan.expected_shared_state.review_batches) {
    if (review.lifecycle !== "responded") continue;
    if (
      review.response_evidence_commitment === null ||
      review.response_import_id === null ||
      !(await verifyReviewResponseEvidenceCommitment({
        schema_version: 1,
        project_id: plan.destination_project_id,
        review_batch_id: review.review_batch_id,
        response_import_id: review.response_import_id,
        contribution_payload_ids: review.contribution_payload_ids
      }, review.response_evidence_commitment))
    ) {
      throw new Error("Bootstrap review response evidence commitment mismatch.");
    }
  }
  const identityCommitment = await contentCommitment("identity-map", plan.identity_mappings);
  if (identityCommitment !== plan.identity_map_commitment) {
    throw new Error("Bootstrap identity-map commitment mismatch.");
  }
  const expectedPlanCommitment = await contentCommitment("plan", planCoreForCommitment(plan));
  if (expectedPlanCommitment !== plan.plan_commitment) {
    throw new Error("Bootstrap plan commitment mismatch.");
  }
  return plan;
}

async function buildPlan(input: Readonly<{
  authority: ParsedBootstrapAuthority;
  bootstrap_kind: "native" | "duplicate_current_state";
  source_inventory_commitment: BootstrapCommitment | null;
  identity_mappings: readonly PlannedIdentityMapping[];
  excluded_private_fields: readonly PrivateImportFieldName[];
  warnings: readonly string[];
  markdown_objects: readonly PlannedMarkdownObject[];
  revision_objects: readonly PlannedRevisionObject[];
  shared_state: CollaborationBootstrapImportData;
}>): Promise<CollaborationBootstrapPlan> {
  const keyCommitment = await deriveKeyEpochCommitment({
    schema_version: 1,
    object_kind: "key_epoch_public_commitment",
    project_id: input.authority.project_id,
    key_epoch_id: input.authority.initial_key_epoch_id,
    commitment_algorithm: "sha256-public-commitment-v1",
    public_commitment_bytes:
      input.authority.initial_key_epoch_public_commitment_bytes
  });
  const deviceAuthority = freezeRecord({
    device_id: input.authority.owner_device_id,
    person_id: input.authority.owner_person_id,
    signing_key_id: input.authority.owner_device_signing_key_id,
    role: "owner" as const,
    capabilities: Object.freeze([...capabilitiesForRole("owner")]),
    status: "active" as const,
    maximum_accepted_semantic_sequence: null
  });
  const controlState: ControlStateCommitment = freezeRecord({
    schema_version: 1,
    object_kind: "control_state_commitment" as const,
    project_id: input.authority.project_id,
    owner_person_id: input.authority.owner_person_id,
    active_control_device_id: input.authority.owner_device_id,
    offline_root_key_id: input.authority.offline_root_public_key_id,
    key_epoch_id: input.authority.initial_key_epoch_id,
    key_epoch_commitment: keyCommitment.id,
    merge_policy: input.authority.initial_merge_policy,
    root_sequence: BigInt(0) as UInt64,
    recovery_last_uncontested_control_id: null,
    device_authorities: Object.freeze([deviceAuthority])
  });
  const controlRoot = await deriveControlStateRoot(controlState);
  const controlGenesis = parseControlEventCore({
    schema_version: 1,
    object_kind: "control_event_core",
    control_kind: "genesis",
    project_id: input.authority.project_id,
    control_sequence: BigInt(0),
    previous_control_id: null,
    root_sequence: BigInt(0),
    previous_root_control_id: null,
    owner_person_id: input.authority.owner_person_id,
    offline_root_key_id: input.authority.offline_root_public_key_id,
    initial_active_control_device_id: input.authority.owner_device_id,
    initial_memberships: [{
      membership_id: input.authority.owner_membership_id,
      person_id: input.authority.owner_person_id,
      role: "owner",
      access_scope_id: input.authority.owner_access_scope_id,
      status: "active"
    }],
    initial_authorized_devices: [{
      device_id: input.authority.owner_device_id,
      person_id: input.authority.owner_person_id,
      signing_key_id: input.authority.owner_device_signing_key_id,
      status: "active"
    }],
    initial_key_epoch_id: input.authority.initial_key_epoch_id,
    initial_key_epoch_commitment: keyCommitment.id,
    resulting_control_state_root: controlRoot.id
  });
  if (controlGenesis.control_kind !== "genesis") {
    throw new Error("Bootstrap control planning failed to construct genesis.");
  }
  const controlIdentity = await deriveControlEventCoreIdentity(controlGenesis);
  const payload = parseSemanticPayloadCore({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: input.authority.project_id,
    semantic_kind: "collaboration_bootstrap_import",
    data: input.shared_state
  });
  if (payload.semantic_kind !== "collaboration_bootstrap_import") {
    throw new Error("Bootstrap payload planning constructed the wrong semantic kind.");
  }
  const payloadIdentity = await deriveSemanticPayloadIdentity(payload);
  const eventCore = parseSemanticEventCoreStructure({
    schema_version: SEMANTIC_EVENT_CORE_SCHEMA_VERSION,
    object_kind: "semantic_event_core",
    project_id: input.authority.project_id,
    semantic_kind: "collaboration_bootstrap_import",
    author_device_id: input.authority.owner_device_id,
    device_sequence: BigInt(0),
    device_chain_position: "first",
    previous_device_event_id: null,
    causal_parent_event_ids: [],
    authorizing_control_head_id: controlIdentity.id,
    key_epoch_id: input.authority.initial_key_epoch_id,
    semantic_payload_id: payloadIdentity.id,
    complete_known_frontier: true
  });
  if (
    eventCore.semantic_kind !== payload.semantic_kind ||
    eventCore.semantic_payload_id !== payloadIdentity.id
  ) {
    throw new Error("Bootstrap semantic event planning did not bind its payload.");
  }
  const eventIdentity = await deriveSemanticEventCoreIdentity(eventCore);
  const identityCommitment = await contentCommitment(
    "identity-map",
    input.identity_mappings
  );
  const core = {
    schema_version: BOOTSTRAP_PLAN_SCHEMA_VERSION,
    object_kind: "collaboration_bootstrap_plan" as const,
    authority: "none" as const,
    bootstrap_kind: input.bootstrap_kind,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    reducer_version: INITIAL_REDUCER_VERSION,
    destination_project_id: input.authority.project_id,
    source_inventory_commitment: input.source_inventory_commitment,
    identity_map_commitment: identityCommitment,
    identity_mappings: Object.freeze([...input.identity_mappings]),
    excluded_private_fields: input.excluded_private_fields,
    warnings: input.warnings,
    owner_person_id: input.authority.owner_person_id,
    owner_device_id: input.authority.owner_device_id,
    owner_device_signing_key_id: input.authority.owner_device_signing_key_id,
    initial_key_epoch_id: input.authority.initial_key_epoch_id,
    initial_key_epoch_commitment: keyCommitment.id,
    initial_merge_policy: input.authority.initial_merge_policy,
    control_state: controlState,
    control_state_root: controlRoot.id,
    control_genesis_core: controlGenesis,
    expected_control_event_id: controlIdentity.id,
    markdown_objects: input.markdown_objects,
    revision_objects: input.revision_objects,
    semantic_payload_core: payload,
    expected_semantic_payload_id: payloadIdentity.id,
    semantic_event_core: eventCore,
    expected_semantic_event_id: eventIdentity.id,
    expected_shared_state: input.shared_state,
    construction_order: bootstrapConstructionStages,
    final_verification_requirements: finalVerificationRequirements,
    destination_label: "local_collaboration_foundation_only" as const,
    unavailable_capabilities: unavailableCapabilities
  };
  const planCommitment = await contentCommitment("plan", core);
  return Object.freeze({ ...core, plan_commitment: planCommitment });
}

function planCoreForCommitment(plan: CollaborationBootstrapPlan): unknown {
  return Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== "plan_commitment")
  );
}

async function planNativeCurrentObjects(
  input: NativeCollaborationBootstrapInput
): Promise<Readonly<{
  markdownObjects: readonly PlannedMarkdownObject[];
  revisionObjects: readonly PlannedRevisionObject[];
  documents: readonly BootstrapSharedDocument[];
}>> {
  const markdownObjects: PlannedMarkdownObject[] = [];
  const revisionObjects: PlannedRevisionObject[] = [];
  const documents: BootstrapSharedDocument[] = [];
  for (const document of input.documents) {
    const blob = await deriveMarkdownBlobIdentity(input.project_id, document.markdown_bytes);
    const core = parseDocumentRevisionCore({
      schema_version: 1,
      object_kind: "document_revision_core",
      ancestry_kind: "genesis",
      project_id: input.project_id,
      document_id: document.document_id,
      markdown_blob_id: blob.id,
      parent_revision_ids: []
    });
    const revision = await deriveDocumentRevisionIdentity(core);
    markdownObjects.push(freezeRecord({
      object_role: "current_document" as const,
      project_id: input.project_id,
      document_id: document.document_id,
      markdown_blob_id: blob.id,
      exact_bytes: Uint8Array.from(document.markdown_bytes)
    }));
    revisionObjects.push(freezeRecord({
      object_role: "baseline_revision" as const,
      document_id: document.document_id,
      revision_id: revision.id,
      core
    }));
    documents.push(freezeRecord({
      document_id: document.document_id,
      markdown_blob_id: blob.id,
      baseline_revision_id: revision.id,
      title: document.title,
      logical_path: document.logical_path,
      position: document.position,
      group_id: document.group_id,
      archive_status: document.archive_status,
      tombstone: document.tombstone,
      shared_roles: document.shared_roles,
      comments: document.comments,
      patches: Object.freeze(document.patches.map((patch): BootstrapSharedPatch => freezeRecord({
        patch_id: patch.patch_id,
        versions: Object.freeze(patch.versions.map((version) => freezeRecord({
          patch_version_id: version.patch_version_id,
          revision_id: version.revision_source === "document_current" ? revision.id : null,
          dependency_patch_version_ids: version.dependency_patch_version_ids,
          decision: version.decision,
          target_provenance: version.target_provenance,
          imported_provenance: null
        })))
      }))),
      reference_document_ids: document.reference_document_ids
    }));
  }
  return freezeRecord({
    markdownObjects: Object.freeze(markdownObjects.sort(markdownCompare)),
    revisionObjects: Object.freeze(revisionObjects.sort(revisionCompare)),
    documents: Object.freeze(documents.sort((a, b) => compare(a.document_id, b.document_id)))
  });
}

async function buildBootstrapReviewBatch(
  projectId: ProjectId,
  reviewBatchId: ReviewBatchId,
  lifecycle: "active" | "responded" | "cancelled",
  responseImportId: ReviewResponseImportId | null,
  importedProvenance: string | null,
  contributionPayloadIds: readonly SemanticPayloadId[]
): Promise<BootstrapSharedReviewBatch> {
  if (lifecycle !== "responded") {
    if (responseImportId !== null || contributionPayloadIds.length > 0) {
      throw new Error(
        "Only a responded bootstrap review may carry response evidence."
      );
    }
    return freezeRecord({
      review_batch_id: reviewBatchId,
      lifecycle,
      response_evidence_commitment: null,
      response_import_id: null,
      contribution_payload_ids: Object.freeze([]),
      imported_provenance: importedProvenance
    });
  }
  if (responseImportId === null) {
    throw new Error("A responded bootstrap review requires an explicit response import ID.");
  }
  const evidence = await deriveReviewResponseEvidence({
    schema_version: 1,
    project_id: projectId,
    review_batch_id: reviewBatchId,
    response_import_id: responseImportId,
    contribution_payload_ids: contributionPayloadIds
  });
  return freezeRecord({
    review_batch_id: reviewBatchId,
    lifecycle,
    response_evidence_commitment: evidence.commitment,
    response_import_id: responseImportId,
    contribution_payload_ids: evidence.core.contribution_payload_ids,
    imported_provenance: importedProvenance
  });
}

async function planDuplicationObjects(
  projectId: ProjectId,
  inventory: NormalizedDuplicationSourceInventory,
  allocations: ReadonlyMap<string, DestinationIdentityAllocation>
): Promise<Readonly<{
  markdownObjects: readonly PlannedMarkdownObject[];
  revisionObjects: readonly PlannedRevisionObject[];
  baselineBySourceDocument: ReadonlyMap<string, Readonly<{
    document_id: DocumentId;
    markdown_blob_id: MarkdownBlobId;
    revision_id: DocumentRevisionId;
  }>>;
  evidenceBySourceDocumentAndOrder: ReadonlyMap<string, MarkdownBlobId>;
}>> {
  const markdownObjects: PlannedMarkdownObject[] = [];
  const revisionObjects: PlannedRevisionObject[] = [];
  const baselineBySourceDocument = new Map();
  const evidence = new Map<string, MarkdownBlobId>();
  for (const source of inventory.documents) {
    const documentId = allocationId(allocations, source.source_key, "document") as DocumentId;
    const blob = await deriveMarkdownBlobIdentity(projectId, source.markdown_bytes);
    const core = parseDocumentRevisionCore({
      schema_version: 1,
      object_kind: "document_revision_core",
      ancestry_kind: "genesis",
      project_id: projectId,
      document_id: documentId,
      markdown_blob_id: blob.id,
      parent_revision_ids: []
    });
    const revision = await deriveDocumentRevisionIdentity(core);
    markdownObjects.push(freezeRecord({
      object_role: "current_document" as const,
      project_id: projectId,
      document_id: documentId,
      markdown_blob_id: blob.id,
      exact_bytes: Uint8Array.from(source.markdown_bytes)
    }));
    revisionObjects.push(freezeRecord({
      object_role: "baseline_revision" as const,
      document_id: documentId,
      revision_id: revision.id,
      core
    }));
    baselineBySourceDocument.set(source.source_key, freezeRecord({
      document_id: documentId,
      markdown_blob_id: blob.id,
      revision_id: revision.id
    }));
  }
  for (const version of inventory.manual_versions) {
    const baseline = baselineBySourceDocument.get(version.document_source_key);
    if (!baseline) throw new Error("Manual version document mapping is unavailable.");
    const blob = await deriveMarkdownBlobIdentity(projectId, version.markdown_bytes);
    markdownObjects.push(freezeRecord({
      object_role: "imported_legacy_version" as const,
      project_id: projectId,
      document_id: baseline.document_id,
      markdown_blob_id: blob.id,
      exact_bytes: Uint8Array.from(version.markdown_bytes)
    }));
    evidence.set(
      `${version.document_source_key}\u0000${version.advisory_order.toString()}`,
      blob.id
    );
  }
  return freezeRecord({
    markdownObjects: Object.freeze(markdownObjects.sort(markdownCompare)),
    revisionObjects: Object.freeze(revisionObjects.sort(revisionCompare)),
    baselineBySourceDocument,
    evidenceBySourceDocumentAndOrder: evidence
  });
}

async function duplicationSharedState(
  projectId: ProjectId,
  inventory: NormalizedDuplicationSourceInventory,
  allocations: ReadonlyMap<string, DestinationIdentityAllocation>,
  objects: Awaited<ReturnType<typeof planDuplicationObjects>>,
  sourceCommitment: BootstrapCommitment,
  migrationPlan: IdentityMigrationPlan,
  identityMappings: readonly PlannedIdentityMapping[],
  aliases: readonly LegacyIdentityAlias[]
): Promise<CollaborationBootstrapImportData> {
  const groups = inventory.groups.map((source): BootstrapSharedGroup => freezeRecord({
    group_id: allocationId(allocations, source.source_key, "group") as GroupId,
    title: source.title,
    position: source.position
  })).sort((a, b) => compare(a.group_id, b.group_id));
  const documents = inventory.documents.map((source): BootstrapSharedDocument => {
    const baseline = objects.baselineBySourceDocument.get(source.source_key);
    if (!baseline) throw new Error("Source document baseline mapping is unavailable.");
    return freezeRecord({
      document_id: baseline.document_id,
      markdown_blob_id: baseline.markdown_blob_id,
      baseline_revision_id: baseline.revision_id,
      title: source.title,
      logical_path: source.logical_path,
      position: source.position,
      group_id: source.group_source_key === null
        ? null
        : allocationId(allocations, source.group_source_key, "group") as GroupId,
      archive_status: source.archive_status,
      tombstone: source.tombstone,
      shared_roles: source.shared_roles,
      comments: Object.freeze(source.comments.map((comment) => freezeRecord({
        comment_id: allocationId(allocations, comment.source_key, "comment") as CommentId,
        body: comment.body,
        anchor: comment.anchor,
        status: comment.status,
        trash_status: comment.trash_status,
        tombstone: comment.tombstone,
        imported_provenance: comment.imported_provenance,
        imported_history: comment.imported_history,
        replies: Object.freeze(comment.replies.map((reply) => freezeRecord({
          reply_id: allocationId(allocations, reply.source_key, "reply") as ReplyId,
          body: reply.body,
          tombstone: reply.tombstone,
          imported_provenance: reply.imported_provenance,
          imported_history: reply.imported_history
        })).sort((a, b) => compare(a.reply_id, b.reply_id)))
      })).sort((a, b) => compare(a.comment_id, b.comment_id))),
      patches: Object.freeze(source.patches.map((patch): BootstrapSharedPatch => freezeRecord({
        patch_id: allocationId(allocations, patch.source_key, "patch") as PatchId,
        versions: Object.freeze(patch.versions.map((version) => freezeRecord({
          patch_version_id: allocationId(
            allocations,
            version.source_key,
            "patch-version"
          ) as PatchVersionId,
          revision_id: version.revision_source === "document_current"
            ? baseline.revision_id
            : null,
          dependency_patch_version_ids: Object.freeze(
            version.dependency_source_keys.map((key) =>
              allocationId(allocations, key, "patch-version") as PatchVersionId
            ).sort()
          ),
          decision: version.decision,
          target_provenance: version.target_provenance,
          imported_provenance: version.imported_provenance
        })).sort((a, b) => compare(a.patch_version_id, b.patch_version_id)))
      })).sort((a, b) => compare(a.patch_id, b.patch_id))),
      reference_document_ids: Object.freeze(
        source.reference_document_source_keys.map((key) =>
          allocationId(allocations, key, "document") as DocumentId
        ).sort()
      )
    });
  }).sort((a, b) => compare(a.document_id, b.document_id));
  const reviewBatches = (await Promise.all(inventory.review_batches.map((source) =>
    buildBootstrapReviewBatch(
      projectId,
      allocationId(
        allocations,
        source.source_key,
        "review-batch"
      ) as ReviewBatchId,
      source.lifecycle,
      source.response_import_id,
      source.imported_provenance,
      Object.freeze([])
    )
  ))).sort((a, b) => compare(a.review_batch_id, b.review_batch_id));
  const rewrites = inventory.rewrite_sessions.map((source): BootstrapSharedRewriteSession => {
    const baseline = objects.baselineBySourceDocument.get(source.document_source_key);
    if (!baseline) throw new Error("Rewrite source document mapping is unavailable.");
    return freezeRecord({
      rewrite_session_id: allocationId(
        allocations,
        source.source_key,
        "rewrite-session"
      ) as RewriteSessionId,
      document_id: baseline.document_id,
      outcome: source.outcome,
      applied_revision_ids: source.applies_current_revision
        ? Object.freeze([baseline.revision_id])
        : Object.freeze([]),
      imported_provenance: source.imported_provenance
    });
  }).sort((a, b) => compare(a.rewrite_session_id, b.rewrite_session_id));
  const versions = inventory.manual_versions.map((source): ImportedLegacyVersion => {
    const baseline = objects.baselineBySourceDocument.get(source.document_source_key);
    const blob = objects.evidenceBySourceDocumentAndOrder.get(
      `${source.document_source_key}\u0000${source.advisory_order.toString()}`
    );
    if (!baseline || !blob) throw new Error("Manual version evidence mapping is unavailable.");
    return freezeRecord({
      document_id: baseline.document_id,
      markdown_blob_id: blob,
      advisory_order: source.advisory_order,
      imported_provenance: source.imported_provenance
    });
  }).sort((a, b) => compare(
    `${a.document_id}\u0000${a.advisory_order.toString().padStart(20, "0")}`,
    `${b.document_id}\u0000${b.advisory_order.toString().padStart(20, "0")}`
  ));
  return parseCollaborationBootstrapImportData({
    schema_version: BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION,
    import_policy_version: BOOTSTRAP_IMPORT_POLICY_VERSION,
    bootstrap_kind: "duplicate_current_state",
    earlier_collaboration_history: "does_not_exist",
    source_inventory_commitment: sourceCommitment,
    project_title: inventory.source_project.title,
    project_metadata: inventory.project_metadata,
    group_order: inventory.group_order.map((key) => allocationId(allocations, key, "group")),
    groups,
    document_order: inventory.document_order.map((key) => allocationId(allocations, key, "document")),
    documents,
    review_batches: reviewBatches,
    rewrite_sessions: rewrites,
    identity_migration_plan: migrationPlan,
    identity_mappings: identityMappings,
    legacy_aliases: aliases,
    imported_legacy_versions: versions
  }, projectId);
}

function buildDuplicationIdentityPlan(
  inventory: NormalizedDuplicationSourceInventory,
  allocations: ReadonlyMap<string, DestinationIdentityAllocation>,
  collisions: DestinationCollisionSnapshot,
  destinationProjectId: ProjectId
): Readonly<{
  mappings: readonly PlannedIdentityMapping[];
  aliases: readonly LegacyIdentityAlias[];
  migrationPlan: IdentityMigrationPlan;
  warnings: readonly string[];
}> {
  const sources = sourceIdentityEntries(inventory);
  if (allocations.size !== sources.length) {
    throw new Error("Destination allocation map must contain every source entity exactly once.");
  }
  const checked = new Set(collisions.checked_authoritative_ids);
  const occupied = new Set(collisions.occupied_authoritative_ids);
  const authoritativeIds = [...allocations.values()].map((entry) => entry.authoritative_id);
  if (new Set(authoritativeIds).size !== authoritativeIds.length) {
    throw new Error("Destination allocations contain duplicate authoritative IDs.");
  }
  for (const id of authoritativeIds) {
    if (!checked.has(id)) {
      throw new Error("Every destination identity requires explicit registry collision verification.");
    }
    if (occupied.has(id)) {
      throw new Error(`Destination identity ${id} already exists in the destination registry.`);
    }
  }
  const projectAllocation = allocations.get("project");
  if (
    projectAllocation?.identity_kind !== "project" ||
    projectAllocation.authoritative_id !== destinationProjectId
  ) {
    throw new Error("Destination project allocation does not match the requested project ID.");
  }
  const duplicateLegacyKeys = duplicateLegacyIdentityKeys(sources);
  const migrationScope = inventory.source_project.legacy_id ?? inventory.source_project.source_key;
  const aliases: LegacyIdentityAlias[] = [];
  const decisions: IdentityMigrationDecision[] = [];
  const mappings: PlannedIdentityMapping[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    const allocation = allocations.get(source.source_key);
    if (!allocation || allocation.identity_kind !== source.identity_kind) {
      throw new Error(`Destination allocation for ${source.source_key} has the wrong identity kind.`);
    }
    const policyKind = existingPolicyKind(source.identity_kind);
    if (policyKind === null) {
      mappings.push(freezeRecord({
        source_key: source.source_key,
        identity_kind: source.identity_kind,
        source_id: source.legacy_id,
        disposition: "replace" as const,
        authoritative_id: allocation.authoritative_id,
        alias: null,
        note: "Patch-version identity is always independently allocated."
      }));
      continue;
    }
    const duplicate = source.legacy_id !== null && duplicateLegacyKeys.has(
      `${policyKind}\u0000${source.legacy_id}`
    );
    const classification = classifyExistingIdentity(policyKind, source.legacy_id);
    if (classification.disposition === "preserve_candidate" && !duplicate) {
      if (!collisions.trusted_legacy_ids_verified_unique.includes(classification.existing_id)) {
        throw new Error("Trusted legacy UUID adoption requires explicit project-wide collision verification.");
      }
      const normalizedAdoptionId = normalizeTrustedLegacyUuidIdentity(
        source.identity_kind,
        classification.existing_id
      );
      if (allocation.authoritative_id !== normalizedAdoptionId) {
        throw new Error(
          "Trusted legacy UUID adoption requires the exact lossless canonical destination identity."
        );
      }
      warnings.push(
        `Trusted adoption verified and canonically normalized for ${source.source_key}.`
      );
      mappings.push(freezeRecord({
        source_key: source.source_key,
        identity_kind: source.identity_kind,
        source_id: source.legacy_id,
        disposition: "trusted_adopt" as const,
        authoritative_id: allocation.authoritative_id,
        alias: null,
        note: "Verified UUID bytes were losslessly normalized into the canonical collaboration namespace."
      }));
      continue;
    }
    const reason = duplicate
      ? "duplicate_in_migration_scope" as const
      : classification.disposition === "replace_and_alias"
        ? classification.replacement_reason
        : "duplicate_in_migration_scope" as const;
    const alias = source.legacy_id === null
      ? null
      : adaptLegacyIdentity({
          identityKind: policyKind,
          legacyId: source.legacy_id,
          scope: aliasScope(source, inventory, migrationScope)
        });
    if (alias !== null) aliases.push(alias);
    const decision = freezeRecord({
      decision: "replace_and_alias" as const,
      identity_kind: policyKind,
      previous_id: source.legacy_id,
      replacement_reason: reason,
      authoritative_id: allocation.authoritative_id as never,
      legacy_alias: alias
    });
    decisions.push(decision);
    mappings.push(freezeRecord({
      source_key: source.source_key,
      identity_kind: source.identity_kind,
      source_id: source.legacy_id,
      disposition: alias === null ? "replace" as const : "replace_and_alias" as const,
      authoritative_id: allocation.authoritative_id,
      alias,
      note: null
    }));
  }
  decisions.sort((left, right) => compare(
    decisionKey(left),
    decisionKey(right)
  ));
  aliases.sort((left, right) => compare(aliasSortKey(left), aliasSortKey(right)));
  const uniqueAliases = [...new Map(
    aliases.map((alias) => [aliasSortKey(alias), alias] as const)
  ).values()];
  const migrationPlan = parseIdentityMigrationPlan({
    schema_version: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
    object_kind: "identity_migration_plan",
    migration_scope_id: migrationScope,
    collision_policy: "project_wide_exact_identity_uniqueness_required",
    entries: decisions
  });
  return freezeRecord({
    mappings: Object.freeze(mappings.sort(mappingCompare)),
    aliases: Object.freeze(uniqueAliases),
    migrationPlan,
    warnings: Object.freeze([...new Set(warnings)].sort())
  });
}

export function normalizeTrustedLegacyUuidIdentity(
  kind: DestinationIdentityKind,
  value: string
): string {
  const policyKind = existingPolicyKind(kind);
  if (policyKind === null) {
    throw new Error("Patch-version identities do not support trusted legacy adoption.");
  }
  const classification = classifyExistingIdentity(policyKind, value);
  if (classification.disposition !== "preserve_candidate") {
    throw new Error("Trusted legacy adoption requires a supported UUID-v4 source identity.");
  }
  const uuid = classification.existing_id.slice(-36);
  const hex = uuid.replaceAll("-", "");
  const raw = new Uint8Array(16);
  for (let index = 0; index < raw.length; index += 1) {
    raw[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return parseEntityId(kind, `pm:${kind}:v1:${encodeUuidV4EntityBody(raw)}`);
}

function encodeUuidV4EntityBody(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bits: number[] = [0, 0, 0, 0, 0];
  for (let bitIndex = 0; bitIndex < bytes.length * 8; bitIndex += 1) {
    if (
      (bitIndex >= 48 && bitIndex <= 51) ||
      (bitIndex >= 64 && bitIndex <= 65)
    ) {
      continue;
    }
    const byte = bytes[Math.floor(bitIndex / 8)];
    bits.push((byte >>> (7 - (bitIndex % 8))) & 1);
  }
  if (bits.length !== 127) {
    throw new Error("UUID-v4 normalization did not preserve exactly 122 variable bits.");
  }
  let output = "";
  for (let offset = 0; offset < bits.length; offset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      value = (value << 1) | (bits[offset + index] ?? 0);
    }
    output += alphabet[value];
  }
  if (output.length !== 26) {
    throw new Error("Trusted UUID normalization did not produce one entity identity.");
  }
  return output;
}

type SourceIdentityEntry = SourceIdentity & Readonly<{
  identity_kind: DestinationIdentityKind;
  document_source_key: string | null;
  comment_source_key: string | null;
}>;

function sourceIdentityEntries(
  inventory: NormalizedDuplicationSourceInventory
): readonly SourceIdentityEntry[] {
  const entries: SourceIdentityEntry[] = [{
    ...inventory.source_project,
    identity_kind: "project",
    document_source_key: null,
    comment_source_key: null
  }];
  for (const group of inventory.groups) {
    entries.push({ ...group, identity_kind: "group", document_source_key: null, comment_source_key: null });
  }
  for (const document of inventory.documents) {
    entries.push({ ...document, identity_kind: "document", document_source_key: document.source_key, comment_source_key: null });
    for (const comment of document.comments) {
      entries.push({ ...comment, identity_kind: "comment", document_source_key: document.source_key, comment_source_key: comment.source_key });
      for (const reply of comment.replies) {
        entries.push({ ...reply, identity_kind: "reply", document_source_key: document.source_key, comment_source_key: comment.source_key });
      }
    }
    for (const patch of document.patches) {
      entries.push({ ...patch, identity_kind: "patch", document_source_key: document.source_key, comment_source_key: null });
      for (const version of patch.versions) {
        entries.push({ ...version, identity_kind: "patch-version", document_source_key: document.source_key, comment_source_key: null });
      }
    }
  }
  for (const review of inventory.review_batches) {
    entries.push({ ...review, identity_kind: "review-batch", document_source_key: review.document_source_key, comment_source_key: null });
  }
  for (const rewrite of inventory.rewrite_sessions) {
    entries.push({ ...rewrite, identity_kind: "rewrite-session", document_source_key: rewrite.document_source_key, comment_source_key: null });
  }
  const keys = entries.map((entry) => entry.source_key);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Every normalized source entity requires a project-wide unique source key.");
  }
  return Object.freeze(entries.sort((a, b) => compare(a.source_key, b.source_key)));
}

function duplicateLegacyIdentityKeys(
  entries: readonly SourceIdentityEntry[]
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const kind = existingPolicyKind(entry.identity_kind);
    if (kind === null || entry.legacy_id === null) continue;
    const key = `${kind}\u0000${entry.legacy_id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function aliasScope(
  source: SourceIdentityEntry,
  inventory: NormalizedDuplicationSourceInventory,
  migrationScope: string
): LegacyIdentityAliasScope {
  const document = source.document_source_key === null
    ? null
    : inventory.documents.find((entry) => entry.source_key === source.document_source_key) ?? null;
  const documentScope = document?.legacy_id ?? document?.source_key;
  if (source.identity_kind === "reply") {
    const comment = document?.comments.find(
      (entry) => entry.source_key === source.comment_source_key
    );
    return freezeRecord({
      scope_kind: "comment" as const,
      project_legacy_id: migrationScope,
      document_legacy_id: documentScope ?? source.document_source_key ?? "document",
      comment_legacy_id: comment?.legacy_id ?? comment?.source_key ?? source.comment_source_key ?? "comment"
    });
  }
  if (["comment", "patch", "review-batch", "rewrite-session"].includes(source.identity_kind)) {
    return freezeRecord({
      scope_kind: "document" as const,
      project_legacy_id: migrationScope,
      document_legacy_id: documentScope ?? source.document_source_key ?? "document"
    });
  }
  return freezeRecord({
    scope_kind: "project" as const,
    project_legacy_id: migrationScope
  });
}

function existingPolicyKind(kind: DestinationIdentityKind): ExistingIdentityKind | null {
  return kind === "patch-version" ? null : kind;
}

function decisionKey(decision: IdentityMigrationDecision): string {
  return decision.decision === "preserve_exact_authoritative"
    ? `${decision.adoption.identity_kind}\u0000${decision.adoption.authoritative_id}`
    : `${decision.identity_kind}\u0000${decision.authoritative_id}`;
}

function parseDuplicateCollaborationBootstrapInput(
  value: unknown
): DuplicateCollaborationBootstrapInput {
  const record = expectExactRecord(value, "duplicate collaboration bootstrap input", [
    "schema_version",
    "object_kind",
    "protocol_version",
    "reducer_version",
    "destination_project_id",
    "owner_person_id",
    "owner_membership_id",
    "owner_access_scope_id",
    "owner_device_id",
    "owner_device_signing_key_id",
    "offline_root_public_key_id",
    "initial_key_epoch_number",
    "initial_key_epoch_id",
    "initial_key_epoch_public_commitment_bytes",
    "initial_merge_policy",
    "source_inventory",
    "destination_identity_allocations",
    "collision_snapshot"
  ]);
  expectLiteral(record.schema_version, 1, "duplicate bootstrap input version");
  expectLiteral(record.object_kind, "duplicate_collaboration_bootstrap_input", "duplicate bootstrap input kind");
  parseProtocolVersions(record);
  const inventory = parseNormalizedDuplicationSourceInventory(record.source_inventory);
  const expected = sourceIdentityEntries(inventory);
  const allocations = parseUniqueArray(
    record.destination_identity_allocations,
    "destination identity allocations",
    parseDestinationIdentityAllocation,
    (entry) => entry.source_key,
    { allowEmpty: false, requireSorted: true }
  );
  const expectedKeys = expected.map((entry) => entry.source_key).sort();
  if (!sameStrings(expectedKeys, allocations.map((entry) => entry.source_key))) {
    throw new Error("Destination allocations must exactly cover the normalized source entity registry.");
  }
  const collisions = parseDestinationCollisionSnapshot(record.collision_snapshot);
  if (!sameStrings(
    allocations.map((entry) => entry.authoritative_id).sort(),
    collisions.checked_authoritative_ids
  )) {
    throw new Error("Collision snapshot must check the exact frozen destination allocation set.");
  }
  return freezeRecord({
    schema_version: 1 as const,
    object_kind: "duplicate_collaboration_bootstrap_input" as const,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    reducer_version: INITIAL_REDUCER_VERSION,
    destination_project_id: parseEntityId("project", record.destination_project_id),
    ...parseAuthorityFields(record),
    source_inventory: inventory,
    destination_identity_allocations: allocations,
    collision_snapshot: collisions
  });
}

function parseDestinationIdentityAllocation(
  value: unknown
): DestinationIdentityAllocation {
  const record = expectExactRecord(value, "destination identity allocation", [
    "source_key",
    "identity_kind",
    "authoritative_id"
  ]);
  const kind = expectEnum(
    record.identity_kind,
    destinationIdentityKinds,
    "destination identity kind"
  );
  return freezeRecord({
    source_key: expectNonEmptyString(record.source_key, "destination source key"),
    identity_kind: kind,
    authoritative_id: parseEntityId(kind as EntityIdKind, record.authoritative_id)
  });
}

function parseAuthorityFields(record: Readonly<Record<string, unknown>>): Omit<
  ParsedBootstrapAuthority,
  "project_id"
> {
  return freezeRecord({
    owner_person_id: parseEntityId("person", record.owner_person_id),
    owner_membership_id: parseEntityId("membership", record.owner_membership_id),
    owner_access_scope_id: parseEntityId("access-scope", record.owner_access_scope_id),
    owner_device_id: parseEntityId("device", record.owner_device_id),
    owner_device_signing_key_id: parseEntityId(
      "public-key",
      record.owner_device_signing_key_id
    ),
    offline_root_public_key_id: parseEntityId(
      "public-key",
      record.offline_root_public_key_id
    ),
    initial_key_epoch_number: expectZeroUInt64(
      record.initial_key_epoch_number,
      "initial key epoch number"
    ),
    initial_key_epoch_id: parseEntityId("key-epoch", record.initial_key_epoch_id),
    initial_key_epoch_public_commitment_bytes: exactBytes(
      record.initial_key_epoch_public_commitment_bytes,
      "initial key epoch public commitment"
    ),
    initial_merge_policy: expectEnum(
      record.initial_merge_policy,
      ["manual", "auto_safe"] as const,
      "initial merge policy"
    )
  });
}

function bootstrapAuthority(
  projectId: ProjectId,
  value: Omit<ParsedBootstrapAuthority, "project_id">
): ParsedBootstrapAuthority {
  return freezeRecord({ project_id: projectId, ...value });
}

function parseNativeGroup(value: unknown): BootstrapSharedGroup {
  const record = expectExactRecord(value, "native bootstrap group", [
    "group_id",
    "title",
    "position"
  ]);
  return freezeRecord({
    group_id: parseEntityId("group", record.group_id),
    title: expectString(record.title, "native group title"),
    position: expectString(record.position, "native group position")
  });
}

function parseNativeDocument(value: unknown): NativeBootstrapDocumentInput {
  const record = expectExactRecord(value, "native bootstrap document", [
    "document_id",
    "markdown_bytes",
    "title",
    "logical_path",
    "position",
    "group_id",
    "archive_status",
    "tombstone",
    "shared_roles",
    "comments",
    "patches",
    "reference_document_ids"
  ]);
  const documentId = parseEntityId("document", record.document_id);
  const comments = parseNativeComments(record.comments);
  const patches = parseUniqueArray(
    record.patches,
    "native patches",
    parseNativePatch,
    (entry) => entry.patch_id,
    { allowEmpty: true, requireSorted: true }
  );
  return freezeRecord({
    document_id: documentId,
    markdown_bytes: exactUtf8Bytes(record.markdown_bytes, "native Markdown"),
    title: expectString(record.title, "native document title"),
    logical_path: expectString(record.logical_path, "native logical path"),
    position: expectString(record.position, "native document position"),
    group_id: record.group_id === null ? null : parseEntityId("group", record.group_id),
    archive_status: expectEnum(record.archive_status, ["active", "archived"] as const, "native archive status"),
    tombstone: expectBoolean(record.tombstone, "native document tombstone"),
    shared_roles: parseSortedStrings(record.shared_roles, "native document shared roles"),
    comments,
    patches,
    reference_document_ids: parseSortedUniqueArray(
      record.reference_document_ids,
      "native document references",
      (entry) => parseEntityId("document", entry),
      { allowEmpty: true }
    )
  });
}

function parseNativeComments(
  value: unknown
): readonly BootstrapSharedComment[] {
  return parseUniqueArray(
    value,
    "native comments",
    (entry) => {
      const record = expectExactRecord(entry, "native comment", [
        "comment_id",
        "body",
        "anchor",
        "status",
        "trash_status",
        "tombstone",
        "imported_provenance",
        "imported_history",
        "replies"
      ]);
      if (record.imported_provenance !== null || expectArray(record.imported_history, "native comment history").length > 0) {
        throw new Error("Native comments cannot contain imported provenance or history.");
      }
      const replies = parseUniqueArray(
        record.replies,
        "native replies",
        (reply) => {
          const child = expectExactRecord(reply, "native reply", [
            "reply_id",
            "body",
            "tombstone",
            "imported_provenance",
            "imported_history"
          ]);
          if (child.imported_provenance !== null || expectArray(child.imported_history, "native reply history").length > 0) {
            throw new Error("Native replies cannot contain imported provenance or history.");
          }
          return freezeRecord({
            reply_id: parseEntityId("reply", child.reply_id),
            body: expectString(child.body, "native reply body"),
            tombstone: expectBoolean(child.tombstone, "native reply tombstone"),
            imported_provenance: null,
            imported_history: Object.freeze([])
          });
        },
        (reply) => reply.reply_id,
        { allowEmpty: true, requireSorted: true }
      );
      const trashStatus = expectEnum(
        record.trash_status,
        ["active", "trashed"] as const,
        "native comment trash status"
      );
      const tombstone = expectBoolean(record.tombstone, "native comment tombstone");
      if (tombstone && trashStatus !== "active") {
        throw new Error("A permanently tombstoned native comment cannot remain reversibly trashed.");
      }
      return freezeRecord({
        comment_id: parseEntityId("comment", record.comment_id),
        body: expectString(record.body, "native comment body"),
        anchor: expectString(record.anchor, "native comment anchor"),
        status: expectEnum(record.status, ["open", "resolved"] as const, "native comment status"),
        trash_status: trashStatus,
        tombstone,
        imported_provenance: null,
        imported_history: Object.freeze([]),
        replies
      });
    },
    (entry) => entry.comment_id,
    { allowEmpty: true, requireSorted: true }
  );
}

function parseNativePatch(value: unknown): NativeBootstrapDocumentInput["patches"][number] {
  const record = expectExactRecord(value, "native patch", ["patch_id", "versions"]);
  return freezeRecord({
    patch_id: parseEntityId("patch", record.patch_id),
    versions: parseUniqueArray(
      record.versions,
      "native patch versions",
      (entry) => {
        const version = expectExactRecord(entry, "native patch version", [
          "patch_version_id",
          "revision_source",
          "dependency_patch_version_ids",
          "decision",
          "target_provenance",
          "imported_provenance"
        ]);
        expectLiteral(version.imported_provenance, null, "native patch imported provenance");
        return freezeRecord({
          patch_version_id: parseEntityId("patch-version", version.patch_version_id),
          revision_source: version.revision_source === null
            ? null
            : expectLiteral(version.revision_source, "document_current", "native patch revision source"),
          dependency_patch_version_ids: parseSortedUniqueArray(
            version.dependency_patch_version_ids,
            "native patch dependencies",
            (candidate) => parseEntityId("patch-version", candidate),
            { allowEmpty: true }
          ),
          decision: expectEnum(version.decision, ["pending", "accepted", "rejected"] as const, "native patch decision"),
          target_provenance: version.target_provenance === null ? null : expectString(version.target_provenance, "native target provenance"),
          imported_provenance: null
        });
      },
      (entry) => entry.patch_version_id,
      { allowEmpty: false, requireSorted: true }
    )
  });
}

function parseNativeReview(value: unknown): NativeBootstrapReviewInput {
  const record = expectExactRecord(value, "native review batch", [
    "review_batch_id",
    "lifecycle",
    "response_import_id",
    "imported_provenance"
  ]);
  expectLiteral(record.imported_provenance, null, "native review imported provenance");
  const lifecycle = expectEnum(record.lifecycle, ["active", "responded", "cancelled"] as const, "native review lifecycle");
  const responseImportId = record.response_import_id === null
    ? null
    : parseReviewResponseImportId(record.response_import_id);
  if ((lifecycle === "responded") !== (responseImportId !== null)) {
    throw new Error("Native responded review requires an explicit response import ID.");
  }
  return freezeRecord({
    review_batch_id: parseEntityId("review-batch", record.review_batch_id),
    lifecycle,
    response_import_id: responseImportId,
    imported_provenance: null
  });
}

function parseNativeRewrite(value: unknown): NativeCollaborationBootstrapInput["initial_rewrite_sessions"][number] {
  const record = expectExactRecord(value, "native rewrite session", [
    "rewrite_session_id",
    "document_id",
    "outcome",
    "applies_current_revision",
    "imported_provenance"
  ]);
  expectLiteral(record.imported_provenance, null, "native rewrite imported provenance");
  const outcome = expectEnum(record.outcome, ["active", "discarded", "applied"] as const, "native rewrite outcome");
  const applies = expectBoolean(record.applies_current_revision, "native rewrite applies current revision");
  if ((outcome === "applied") !== applies) throw new Error("Native applied rewrite must apply the current revision.");
  return freezeRecord({
    rewrite_session_id: parseEntityId("rewrite-session", record.rewrite_session_id),
    document_id: parseEntityId("document", record.document_id),
    outcome,
    applies_current_revision: applies,
    imported_provenance: null
  });
}

function parseSourceIdentity(
  record: Readonly<Record<string, unknown>>,
  label: string
): SourceIdentity {
  return freezeRecord({
    source_key: expectNonEmptyString(record.source_key, `${label} source key`),
    legacy_id: record.legacy_id === null
      ? null
      : expectNonEmptyString(record.legacy_id, `${label} legacy ID`)
  });
}

function parseSourceGroup(value: unknown): NormalizedDuplicationSourceInventory["groups"][number] {
  const record = expectExactRecord(value, "source group", [
    "source_key",
    "legacy_id",
    "title",
    "position"
  ]);
  return freezeRecord({
    ...parseSourceIdentity(record, "source group"),
    title: expectString(record.title, "source group title"),
    position: expectString(record.position, "source group position")
  });
}

function parseSourceDocument(value: unknown): SourceDocument {
  const record = expectExactRecord(value, "source document", [
    "source_key",
    "legacy_id",
    "markdown_bytes",
    "title",
    "logical_path",
    "position",
    "group_source_key",
    "archive_status",
    "tombstone",
    "shared_roles",
    "comments",
    "patches",
    "reference_document_source_keys"
  ]);
  return freezeRecord({
    ...parseSourceIdentity(record, "source document"),
    markdown_bytes: exactUtf8Bytes(record.markdown_bytes, "source Markdown"),
    title: expectString(record.title, "source document title"),
    logical_path: expectString(record.logical_path, "source logical path"),
    position: expectString(record.position, "source document position"),
    group_source_key: record.group_source_key === null ? null : expectNonEmptyString(record.group_source_key, "source group key"),
    archive_status: expectEnum(record.archive_status, ["active", "archived"] as const, "source archive status"),
    tombstone: expectBoolean(record.tombstone, "source document tombstone"),
    shared_roles: parseSortedStrings(record.shared_roles, "source shared roles"),
    comments: parseUniqueArray(record.comments, "source comments", parseSourceComment, (entry) => entry.source_key, { allowEmpty: true, requireSorted: true }),
    patches: parseUniqueArray(record.patches, "source patches", parseSourcePatch, (entry) => entry.source_key, { allowEmpty: true, requireSorted: true }),
    reference_document_source_keys: parseSortedStrings(record.reference_document_source_keys, "source document references")
  });
}

function parseSourceComment(value: unknown): SourceComment {
  const record = expectExactRecord(value, "source comment", [
    "source_key",
    "legacy_id",
    "body",
    "anchor",
    "status",
    "trash_status",
    "tombstone",
    "imported_provenance",
    "imported_history",
    "replies"
  ]);
  const trashStatus = expectEnum(
    record.trash_status,
    ["active", "trashed"] as const,
    "source comment trash status"
  );
  const tombstone = expectBoolean(record.tombstone, "source comment tombstone");
  if (tombstone && trashStatus !== "active") {
    throw new Error("A permanently tombstoned source comment cannot remain reversibly trashed.");
  }
  return freezeRecord({
    ...parseSourceIdentity(record, "source comment"),
    body: expectString(record.body, "source comment body"),
    anchor: expectString(record.anchor, "source comment anchor"),
    status: expectEnum(record.status, ["open", "resolved"] as const, "source comment status"),
    trash_status: trashStatus,
    tombstone,
    imported_provenance: nullableString(record.imported_provenance, "source comment provenance"),
    imported_history: parseImportedHistory(record.imported_history),
    replies: parseUniqueArray(record.replies, "source replies", parseSourceReply, (entry) => entry.source_key, { allowEmpty: true, requireSorted: true })
  });
}

function parseSourceReply(value: unknown): SourceComment["replies"][number] {
  const record = expectExactRecord(value, "source reply", [
    "source_key",
    "legacy_id",
    "body",
    "tombstone",
    "imported_provenance",
    "imported_history"
  ]);
  return freezeRecord({
    ...parseSourceIdentity(record, "source reply"),
    body: expectString(record.body, "source reply body"),
    tombstone: expectBoolean(record.tombstone, "source reply tombstone"),
    imported_provenance: nullableString(record.imported_provenance, "source reply provenance"),
    imported_history: parseImportedHistory(record.imported_history)
  });
}

function parseImportedHistory(value: unknown): BootstrapSharedComment["imported_history"] {
  const entries = expectArray(value, "source imported history").map((entry) => {
    const record = expectExactRecord(entry, "source imported history entry", [
      "field",
      "value",
      "advisory_order"
    ]);
    return freezeRecord({
      field: expectEnum(record.field, ["body", "anchor", "status"] as const, "source history field"),
      value: expectString(record.value, "source history value"),
      advisory_order: expectUInt64(record.advisory_order, "source history advisory order")
    });
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].advisory_order >= entries[index].advisory_order) {
      throw new Error("Source imported history order must be strictly increasing.");
    }
  }
  return Object.freeze(entries);
}

function parseSourcePatch(value: unknown): SourcePatch {
  const record = expectExactRecord(value, "source patch", ["source_key", "legacy_id", "versions"]);
  return freezeRecord({
    ...parseSourceIdentity(record, "source patch"),
    versions: parseUniqueArray(
      record.versions,
      "source patch versions",
      (entry) => {
        const version = expectExactRecord(entry, "source patch version", [
          "source_key",
          "legacy_id",
          "revision_source",
          "dependency_source_keys",
          "decision",
          "target_provenance",
          "imported_provenance"
        ]);
        return freezeRecord({
          ...parseSourceIdentity(version, "source patch version"),
          revision_source: version.revision_source === null ? null : expectLiteral(version.revision_source, "document_current", "source patch revision source"),
          dependency_source_keys: parseSortedStrings(version.dependency_source_keys, "source patch dependencies"),
          decision: expectEnum(version.decision, ["pending", "accepted", "rejected"] as const, "source patch decision"),
          target_provenance: nullableString(version.target_provenance, "source target provenance"),
          imported_provenance: nullableString(version.imported_provenance, "source patch provenance")
        });
      },
      (entry) => entry.source_key,
      { allowEmpty: false, requireSorted: true }
    )
  });
}

function parseSourceReview(value: unknown): NormalizedDuplicationSourceInventory["review_batches"][number] {
  const record = expectExactRecord(value, "source review batch", [
    "source_key",
    "legacy_id",
    "document_source_key",
    "lifecycle",
    "response_import_id",
    "imported_provenance"
  ]);
  const lifecycle = expectEnum(record.lifecycle, ["active", "responded", "cancelled"] as const, "source review lifecycle");
  const responseImportId = record.response_import_id === null
    ? null
    : parseReviewResponseImportId(record.response_import_id);
  if ((lifecycle === "responded") !== (responseImportId !== null)) {
    throw new Error("Responded source review requires an explicit response import ID.");
  }
  return freezeRecord({
    ...parseSourceIdentity(record, "source review"),
    document_source_key: expectNonEmptyString(record.document_source_key, "source review document key"),
    lifecycle,
    response_import_id: responseImportId,
    imported_provenance: nullableString(record.imported_provenance, "source review provenance")
  });
}

function parseSourceRewrite(value: unknown): NormalizedDuplicationSourceInventory["rewrite_sessions"][number] {
  const record = expectExactRecord(value, "source rewrite session", [
    "source_key",
    "legacy_id",
    "document_source_key",
    "outcome",
    "applies_current_revision",
    "imported_provenance"
  ]);
  const outcome = expectEnum(record.outcome, ["active", "discarded", "applied"] as const, "source rewrite outcome");
  const applies = expectBoolean(record.applies_current_revision, "source rewrite applies current revision");
  if ((outcome === "applied") !== applies) throw new Error("Only an applied source rewrite may apply the current revision.");
  return freezeRecord({
    ...parseSourceIdentity(record, "source rewrite"),
    document_source_key: expectNonEmptyString(record.document_source_key, "source rewrite document key"),
    outcome,
    applies_current_revision: applies,
    imported_provenance: nullableString(record.imported_provenance, "source rewrite provenance")
  });
}

function parseSourceManualVersion(value: unknown): NormalizedDuplicationSourceInventory["manual_versions"][number] {
  const record = expectExactRecord(value, "source manual version", [
    "document_source_key",
    "markdown_bytes",
    "advisory_order",
    "imported_provenance"
  ]);
  return freezeRecord({
    document_source_key: expectNonEmptyString(record.document_source_key, "manual version document key"),
    markdown_bytes: exactUtf8Bytes(record.markdown_bytes, "manual version Markdown"),
    advisory_order: expectUInt64(record.advisory_order, "manual version advisory order"),
    imported_provenance: expectNonEmptyString(record.imported_provenance, "manual version provenance")
  });
}

function parsePrivateState(value: unknown): NormalizedDuplicationPrivateState {
  const record = expectExactRecord(value, "duplication private state", privateImportFieldNames);
  return Object.freeze(Object.fromEntries(
    privateImportFieldNames.map((field) => [
      field,
      Object.freeze(expectArray(record[field], `private ${field}`).map((entry) => expectString(entry, `private ${field}`)))
    ])
  )) as NormalizedDuplicationPrivateState;
}

function validateSourceRelationships(
  groups: NormalizedDuplicationSourceInventory["groups"],
  documents: readonly SourceDocument[],
  reviews: NormalizedDuplicationSourceInventory["review_batches"],
  rewrites: NormalizedDuplicationSourceInventory["rewrite_sessions"],
  versions: NormalizedDuplicationSourceInventory["manual_versions"]
): void {
  const groupKeys = new Set(groups.map((entry) => entry.source_key));
  const documentKeys = new Set(documents.map((entry) => entry.source_key));
  const patchVersionKeys = new Set<string>();
  const allSourceKeys = new Set<string>(["project", ...groupKeys, ...documentKeys]);
  for (const document of documents) {
    if (document.group_source_key !== null && !groupKeys.has(document.group_source_key)) {
      throw new Error("Source document names a missing group.");
    }
    for (const reference of document.reference_document_source_keys) {
      if (!documentKeys.has(reference)) throw new Error("Source reference names a missing document.");
    }
    for (const comment of document.comments) {
      addUniqueSourceKey(allSourceKeys, comment.source_key);
      for (const reply of comment.replies) addUniqueSourceKey(allSourceKeys, reply.source_key);
    }
    for (const patch of document.patches) {
      addUniqueSourceKey(allSourceKeys, patch.source_key);
      for (const version of patch.versions) {
        addUniqueSourceKey(allSourceKeys, version.source_key);
        patchVersionKeys.add(version.source_key);
      }
    }
  }
  for (const document of documents) {
    for (const patch of document.patches) {
      for (const version of patch.versions) {
        for (const dependency of version.dependency_source_keys) {
          if (!patchVersionKeys.has(dependency) || dependency === version.source_key) {
            throw new Error("Source patch dependency is missing or self-referential.");
          }
        }
      }
    }
  }
  for (const review of reviews) {
    addUniqueSourceKey(allSourceKeys, review.source_key);
    if (!documentKeys.has(review.document_source_key)) throw new Error("Source review names a missing document.");
  }
  for (const rewrite of rewrites) {
    addUniqueSourceKey(allSourceKeys, rewrite.source_key);
    if (!documentKeys.has(rewrite.document_source_key)) throw new Error("Source rewrite names a missing document.");
  }
  for (const version of versions) {
    if (!documentKeys.has(version.document_source_key)) throw new Error("Manual version names a missing document.");
  }
}

function validateSourceKind(inventory: NormalizedDuplicationSourceInventory): void {
  if (inventory.source_kind === "legacy_single_document" && inventory.documents.length !== 1) {
    throw new Error("A legacy single-document source inventory must contain exactly one document.");
  }
}

function validateNativeRelationships(
  groups: readonly BootstrapSharedGroup[],
  documents: readonly NativeBootstrapDocumentInput[]
): void {
  const groupIds = new Set(groups.map((entry) => entry.group_id));
  const documentIds = new Set(documents.map((entry) => entry.document_id));
  const entityIds = new Set<string>([...groupIds, ...documentIds]);
  const patchVersionIds = new Set<PatchVersionId>();
  for (const document of documents) {
    if (document.group_id !== null && !groupIds.has(document.group_id)) throw new Error("Native document names a missing group.");
    for (const reference of document.reference_document_ids) if (!documentIds.has(reference)) throw new Error("Native reference names a missing document.");
    for (const comment of document.comments) {
      addUniqueSourceKey(entityIds, comment.comment_id);
      for (const reply of comment.replies) addUniqueSourceKey(entityIds, reply.reply_id);
    }
    for (const patch of document.patches) {
      addUniqueSourceKey(entityIds, patch.patch_id);
      for (const version of patch.versions) {
        addUniqueSourceKey(entityIds, version.patch_version_id);
        patchVersionIds.add(version.patch_version_id);
      }
    }
  }
  for (const document of documents) {
    for (const patch of document.patches) {
      for (const version of patch.versions) {
        for (const dependency of version.dependency_patch_version_ids) {
          if (!patchVersionIds.has(dependency) || dependency === version.patch_version_id) throw new Error("Native patch dependency is missing or self-referential.");
        }
      }
    }
  }
}

function nativeDocumentMappings(document: NativeBootstrapDocumentInput): PlannedIdentityMapping[] {
  return [
    nativeMapping(document.document_id, "document", document.document_id),
    ...document.comments.flatMap((comment) => [
      nativeMapping(comment.comment_id, "comment", comment.comment_id),
      ...comment.replies.map((reply) => nativeMapping(reply.reply_id, "reply", reply.reply_id))
    ]),
    ...document.patches.flatMap((patch) => [
      nativeMapping(patch.patch_id, "patch", patch.patch_id),
      ...patch.versions.map((version) => nativeMapping(version.patch_version_id, "patch-version", version.patch_version_id))
    ])
  ];
}

function nativeMapping(
  sourceKey: string,
  identityKind: DestinationIdentityKind,
  id: string
): PlannedIdentityMapping {
  return freezeRecord({
    source_key: sourceKey,
    identity_kind: identityKind,
    source_id: null,
    disposition: "native_allocated" as const,
    authoritative_id: id,
    alias: null,
    note: null
  });
}

function parseMetadata(value: unknown): readonly BootstrapSharedMetadataEntry[] {
  return parseUniqueArray(
    value,
    "shared project metadata",
    (entry) => {
      const record = expectExactRecord(entry, "shared metadata entry", ["key", "value"]);
      return freezeRecord({
        key: expectNonEmptyString(record.key, "shared metadata key"),
        value: expectString(record.value, "shared metadata value")
      });
    },
    (entry) => entry.key,
    { allowEmpty: true, requireSorted: true }
  );
}

function parseProtocolVersions(record: Readonly<Record<string, unknown>>): void {
  expectLiteral(record.protocol_version, COLLABORATION_PROTOCOL_VERSION, "collaboration protocol version");
  expectLiteral(record.reducer_version, INITIAL_REDUCER_VERSION, "collaboration reducer version");
}

function parseAuthoritativeOrder<TKind extends "group" | "document">(
  value: unknown,
  kind: TKind,
  ids: readonly string[],
  label: string
): readonly (TKind extends "group" ? GroupId : DocumentId)[] {
  const entries = expectArray(value, label).map((entry) => parseEntityId(kind, entry));
  if (!sameSet(entries, ids)) throw new Error(`${label} must contain every registered entity exactly once.`);
  return Object.freeze(entries) as unknown as readonly (TKind extends "group" ? GroupId : DocumentId)[];
}

function parseSourceOrder(value: unknown, keys: readonly string[], label: string): readonly string[] {
  const entries = expectArray(value, label).map((entry) => expectNonEmptyString(entry, label));
  if (!sameSet(entries, keys)) throw new Error(`${label} must contain every registered source key exactly once.`);
  return Object.freeze(entries);
}

function allocationId(
  allocations: ReadonlyMap<string, DestinationIdentityAllocation>,
  sourceKey: string,
  expectedKind: DestinationIdentityKind
): string {
  const allocation = allocations.get(sourceKey);
  if (!allocation || allocation.identity_kind !== expectedKind) {
    throw new Error(`Missing ${expectedKind} destination allocation for ${sourceKey}.`);
  }
  return allocation.authoritative_id;
}

function requireBaselineRevision(
  documents: readonly BootstrapSharedDocument[],
  documentId: DocumentId
): DocumentRevisionId {
  const document = documents.find((entry) => entry.document_id === documentId);
  if (!document) throw new Error("Initial rewrite names an unavailable baseline revision.");
  return document.baseline_revision_id;
}

async function contentCommitment(
  kind: "source" | "plan" | "identity-map",
  value: unknown
): Promise<BootstrapCommitment> {
  const digest = await sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(`patchmark/bootstrap-${kind}/v1`),
    canonicalProtocolValue(value)
  ])));
  return `pm:bootstrap-${kind}:v1:${encodeSha256Base32(digest)}` as BootstrapCommitment;
}

function exactBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be exact bytes.`);
  return Uint8Array.from(value);
}

function exactUtf8Bytes(value: unknown, label: string): Uint8Array {
  const bytes = exactBytes(value, label);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must contain well-formed UTF-8 bytes.`);
  }
  return bytes;
}

function parseSortedStrings(value: unknown, label: string): readonly string[] {
  const entries = expectArray(value, label).map((entry) => expectString(entry, label));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1] >= entries[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  }
  return Object.freeze(entries);
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : expectString(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function addUniqueSourceKey(target: Set<string>, key: string): void {
  if (target.has(key)) throw new Error(`Duplicate normalized source key ${key}.`);
  target.add(key);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((entry) => right.includes(entry));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function assertExactArray(value: unknown, expected: readonly string[], label: string): void {
  const entries = expectArray(value, label).map((entry) => expectString(entry, label));
  if (!sameStrings(entries, expected)) throw new Error(`${label} does not match the frozen protocol order.`);
}

function aliasSortKey(alias: LegacyIdentityAlias): string {
  return `${alias.identity_kind}\u0000${alias.scope.scope_kind}\u0000${JSON.stringify(alias.scope)}\u0000${alias.legacy_id}`;
}

function mappingCompare(left: PlannedIdentityMapping, right: PlannedIdentityMapping): number {
  return compare(`${left.identity_kind}\u0000${left.source_key}`, `${right.identity_kind}\u0000${right.source_key}`);
}

function markdownCompare(left: PlannedMarkdownObject, right: PlannedMarkdownObject): number {
  return compare(`${left.object_role}\u0000${left.document_id}\u0000${left.markdown_blob_id}`, `${right.object_role}\u0000${right.document_id}\u0000${right.markdown_blob_id}`);
}

function revisionCompare(left: PlannedRevisionObject, right: PlannedRevisionObject): number {
  return compare(left.revision_id, right.revision_id);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

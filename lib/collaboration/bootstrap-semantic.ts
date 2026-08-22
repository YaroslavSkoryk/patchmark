import type {
  DocumentRevisionId,
  GroupId,
  MarkdownBlobId,
  PatchVersionId,
  ProjectId,
  ReviewBatchId,
  RewriteSessionId,
  DocumentId,
  CommentId,
  ReplyId,
  PatchId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import {
  parseIdentityMigrationPlan,
  parseLegacyIdentityAlias,
  type IdentityMigrationPlan,
  type LegacyIdentityAlias
} from "./identity-migration.ts";
import {
  BOOTSTRAP_IMPORT_POLICY_VERSION,
  BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION
} from "./versions.ts";
import {
  expectArray,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectString,
  expectUInt64,
  freezeRecord,
  parseSortedUniqueArray,
  parseUniqueArray,
  type UInt64
} from "./validation.ts";
import {
  parseReviewContributionPayloadIds,
  parseReviewResponseEvidenceCommitment,
  parseReviewResponseImportId,
  type ReviewResponseEvidenceCommitment,
  type ReviewResponseImportId
} from "./review-response-evidence.ts";

export type BootstrapCommitment = string & {
  readonly __bootstrapCommitmentBrand: unique symbol;
};

export type ImportedFieldHistoryEntry = Readonly<{
  field: "body" | "anchor" | "status";
  value: string;
  advisory_order: UInt64;
}>;

export type BootstrapSharedReply = Readonly<{
  reply_id: ReplyId;
  body: string;
  tombstone: boolean;
  imported_provenance: string | null;
  imported_history: readonly ImportedFieldHistoryEntry[];
}>;

export type BootstrapSharedComment = Readonly<{
  comment_id: CommentId;
  body: string;
  anchor: string;
  status: "open" | "resolved";
  trash_status: "active" | "trashed";
  tombstone: boolean;
  imported_provenance: string | null;
  imported_history: readonly ImportedFieldHistoryEntry[];
  replies: readonly BootstrapSharedReply[];
}>;

export type BootstrapSharedPatchVersion = Readonly<{
  patch_version_id: PatchVersionId;
  revision_id: DocumentRevisionId | null;
  dependency_patch_version_ids: readonly PatchVersionId[];
  decision: "pending" | "accepted" | "rejected";
  target_provenance: string | null;
  imported_provenance: string | null;
}>;

export type BootstrapSharedPatch = Readonly<{
  patch_id: PatchId;
  versions: readonly BootstrapSharedPatchVersion[];
}>;

export type BootstrapSharedDocument = Readonly<{
  document_id: DocumentId;
  markdown_blob_id: MarkdownBlobId;
  baseline_revision_id: DocumentRevisionId;
  title: string;
  logical_path: string;
  position: string;
  group_id: GroupId | null;
  archive_status: "active" | "archived";
  tombstone: boolean;
  shared_roles: readonly string[];
  comments: readonly BootstrapSharedComment[];
  patches: readonly BootstrapSharedPatch[];
  reference_document_ids: readonly DocumentId[];
}>;

export type BootstrapSharedGroup = Readonly<{
  group_id: GroupId;
  title: string;
  position: string;
}>;

export type BootstrapSharedMetadataEntry = Readonly<{
  key: string;
  value: string;
}>;

export const bootstrapIdentityKinds = [
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

export type BootstrapIdentityKind = (typeof bootstrapIdentityKinds)[number];

export type BootstrapIdentityMapping = Readonly<{
  source_key: string;
  identity_kind: BootstrapIdentityKind;
  source_id: string | null;
  disposition:
    | "native_allocated"
    | "trusted_adopt"
    | "replace"
    | "replace_and_alias";
  authoritative_id: string;
  alias: LegacyIdentityAlias | null;
  note: string | null;
}>;

export type BootstrapSharedReviewBatch = Readonly<{
  review_batch_id: ReviewBatchId;
  lifecycle: "active" | "responded" | "cancelled";
  response_evidence_commitment: ReviewResponseEvidenceCommitment | null;
  response_import_id: ReviewResponseImportId | null;
  contribution_payload_ids: readonly import("./identities.ts").SemanticPayloadId[];
  imported_provenance: string | null;
}>;

export type BootstrapSharedRewriteSession = Readonly<{
  rewrite_session_id: RewriteSessionId;
  document_id: DocumentId;
  outcome: "active" | "discarded" | "applied";
  applied_revision_ids: readonly DocumentRevisionId[];
  imported_provenance: string | null;
}>;

export type ImportedLegacyVersion = Readonly<{
  document_id: DocumentId;
  markdown_blob_id: MarkdownBlobId;
  advisory_order: UInt64;
  imported_provenance: string;
}>;

/**
 * The one authenticated current-state boundary. Imported labels and histories
 * are evidence only: none of them are event authors, parents, or timestamps.
 */
export type CollaborationBootstrapImportData = Readonly<{
  schema_version: typeof BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION;
  import_policy_version: typeof BOOTSTRAP_IMPORT_POLICY_VERSION;
  bootstrap_kind: "native" | "duplicate_current_state";
  earlier_collaboration_history: "does_not_exist";
  source_inventory_commitment: BootstrapCommitment | null;
  project_title: string;
  project_metadata: readonly BootstrapSharedMetadataEntry[];
  group_order: readonly GroupId[];
  groups: readonly BootstrapSharedGroup[];
  document_order: readonly DocumentId[];
  documents: readonly BootstrapSharedDocument[];
  review_batches: readonly BootstrapSharedReviewBatch[];
  rewrite_sessions: readonly BootstrapSharedRewriteSession[];
  identity_migration_plan: IdentityMigrationPlan | null;
  identity_mappings: readonly BootstrapIdentityMapping[];
  legacy_aliases: readonly LegacyIdentityAlias[];
  imported_legacy_versions: readonly ImportedLegacyVersion[];
}>;

export function parseBootstrapCommitment(
  value: unknown,
  label = "bootstrap commitment"
): BootstrapCommitment {
  const text = expectString(value, label);
  if (!/^pm:bootstrap-(?:source|plan|identity-map):v1:[a-z2-7]{52}$/.test(text)) {
    throw new Error(`${label} must use a supported content commitment namespace.`);
  }
  return text as BootstrapCommitment;
}

export function parseCollaborationBootstrapImportData(
  value: unknown,
  expectedProjectId?: ProjectId
): CollaborationBootstrapImportData {
  const record = expectExactRecord(value, "collaboration bootstrap import data", [
    "schema_version",
    "import_policy_version",
    "bootstrap_kind",
    "earlier_collaboration_history",
    "source_inventory_commitment",
    "project_title",
    "project_metadata",
    "group_order",
    "groups",
    "document_order",
    "documents",
    "review_batches",
    "rewrite_sessions",
    "identity_migration_plan",
    "identity_mappings",
    "legacy_aliases",
    "imported_legacy_versions"
  ]);
  expectLiteral(
    record.schema_version,
    BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION,
    "bootstrap semantic data version"
  );
  expectLiteral(
    record.import_policy_version,
    BOOTSTRAP_IMPORT_POLICY_VERSION,
    "bootstrap import policy version"
  );
  const bootstrapKind = expectEnum(
    record.bootstrap_kind,
    ["native", "duplicate_current_state"] as const,
    "bootstrap kind"
  );
  expectLiteral(
    record.earlier_collaboration_history,
    "does_not_exist",
    "earlier collaboration history statement"
  );
  const sourceCommitment = record.source_inventory_commitment === null
    ? null
    : parseBootstrapCommitment(
        record.source_inventory_commitment,
        "source inventory commitment"
      );
  if (
    (bootstrapKind === "native" && sourceCommitment !== null) ||
    (bootstrapKind === "duplicate_current_state" && sourceCommitment === null)
  ) {
    throw new Error("Only duplicate-current-state bootstrap data may carry a source commitment.");
  }

  const groups = parseUniqueArray(
    record.groups,
    "bootstrap groups",
    parseGroup,
    (entry) => entry.group_id,
    { allowEmpty: true, requireSorted: true }
  );
  const groupIds = new Set(groups.map((entry) => entry.group_id));
  const groupOrder = parseOrderedRegistry(
    record.group_order,
    "group",
    "bootstrap group order",
    groupIds
  );
  const documents = parseUniqueArray(
    record.documents,
    "bootstrap documents",
    parseDocument,
    (entry) => entry.document_id,
    { allowEmpty: true, requireSorted: true }
  );
  const documentIds = new Set(documents.map((entry) => entry.document_id));
  const documentOrder = parseOrderedRegistry(
    record.document_order,
    "document",
    "bootstrap document order",
    documentIds
  );
  validateDocumentRelationships(documents, groupIds, documentIds);

  const reviewBatches = parseUniqueArray(
    record.review_batches,
    "bootstrap review batches",
    parseReviewBatch,
    (entry) => entry.review_batch_id,
    { allowEmpty: true, requireSorted: true }
  );
  const rewriteSessions = parseUniqueArray(
    record.rewrite_sessions,
    "bootstrap rewrite sessions",
    parseRewriteSession,
    (entry) => entry.rewrite_session_id,
    { allowEmpty: true, requireSorted: true }
  );
  for (const session of rewriteSessions) {
    if (!documentIds.has(session.document_id)) {
      throw new Error("Bootstrap rewrite session belongs to an unregistered document.");
    }
  }

  const identityPlan = record.identity_migration_plan === null
    ? null
    : parseIdentityMigrationPlan(record.identity_migration_plan);
  const aliases = parseUniqueArray(
    record.legacy_aliases,
    "bootstrap legacy aliases",
    (entry) => parseLegacyIdentityAlias(entry),
    aliasKey,
    { allowEmpty: true, requireSorted: true }
  );
  const identityMappings = parseUniqueArray(
    record.identity_mappings,
    "bootstrap identity mappings",
    parseBootstrapIdentityMapping,
    (entry) => `${entry.identity_kind}\u0000${entry.source_key}`,
    { allowEmpty: true, requireSorted: true }
  );
  const legacyVersions = parseUniqueArray(
    record.imported_legacy_versions,
    "imported legacy versions",
    parseImportedLegacyVersion,
    (entry) => `${entry.document_id}\u0000${entry.advisory_order.toString().padStart(20, "0")}`,
    { allowEmpty: true, requireSorted: true }
  );
  for (const version of legacyVersions) {
    if (!documentIds.has(version.document_id)) {
      throw new Error("Imported legacy version belongs to an unregistered document.");
    }
  }
  if (bootstrapKind === "native") {
    if (identityPlan !== null || aliases.length > 0 || legacyVersions.length > 0) {
      throw new Error("Native bootstrap data cannot contain legacy import claims.");
    }
  } else if (identityPlan === null) {
    throw new Error("Duplicate-current-state bootstrap data requires a frozen identity plan.");
  }
  validateIdentityMappingCoverage(
    identityMappings,
    expectedProjectId,
    groups,
    documents,
    reviewBatches,
    rewriteSessions
  );

  return freezeRecord({
    schema_version: BOOTSTRAP_SEMANTIC_DATA_SCHEMA_VERSION,
    import_policy_version: BOOTSTRAP_IMPORT_POLICY_VERSION,
    bootstrap_kind: bootstrapKind,
    earlier_collaboration_history: "does_not_exist" as const,
    source_inventory_commitment: sourceCommitment,
    project_title: expectString(record.project_title, "bootstrap project title"),
    project_metadata: parseUniqueArray(
      record.project_metadata,
      "bootstrap project metadata",
      parseMetadataEntry,
      (entry) => entry.key,
      { allowEmpty: true, requireSorted: true }
    ),
    group_order: groupOrder,
    groups,
    document_order: documentOrder,
    documents,
    review_batches: reviewBatches,
    rewrite_sessions: rewriteSessions,
    identity_migration_plan: identityPlan,
    identity_mappings: identityMappings,
    legacy_aliases: aliases,
    imported_legacy_versions: legacyVersions
  });
}

function validateIdentityMappingCoverage(
  mappings: readonly BootstrapIdentityMapping[],
  expectedProjectId: ProjectId | undefined,
  groups: readonly BootstrapSharedGroup[],
  documents: readonly BootstrapSharedDocument[],
  reviews: readonly BootstrapSharedReviewBatch[],
  rewrites: readonly BootstrapSharedRewriteSession[]
): void {
  const expected = new Set<string>();
  if (expectedProjectId !== undefined) {
    expected.add(`project\u0000${expectedProjectId}`);
  }
  for (const group of groups) expected.add(`group\u0000${group.group_id}`);
  for (const document of documents) {
    expected.add(`document\u0000${document.document_id}`);
    for (const comment of document.comments) {
      expected.add(`comment\u0000${comment.comment_id}`);
      for (const reply of comment.replies) expected.add(`reply\u0000${reply.reply_id}`);
    }
    for (const patch of document.patches) {
      expected.add(`patch\u0000${patch.patch_id}`);
      for (const version of patch.versions) {
        expected.add(`patch-version\u0000${version.patch_version_id}`);
      }
    }
  }
  for (const review of reviews) expected.add(`review-batch\u0000${review.review_batch_id}`);
  for (const rewrite of rewrites) expected.add(`rewrite-session\u0000${rewrite.rewrite_session_id}`);

  const actual = new Set(
    mappings.map((mapping) => `${mapping.identity_kind}\u0000${mapping.authoritative_id}`)
  );
  if (new Set(mappings.map((mapping) => mapping.source_key)).size !== mappings.length) {
    throw new Error("Bootstrap identity mapping source keys must be project-wide unique.");
  }
  if (actual.size !== mappings.length) {
    throw new Error("Bootstrap identity mappings contain duplicate authoritative identities.");
  }
  const projectMappings = mappings.filter((mapping) => mapping.identity_kind === "project");
  if (projectMappings.length !== 1) {
    throw new Error("Bootstrap identity mappings must contain exactly one project identity.");
  }
  if (expectedProjectId === undefined) {
    expected.add(`project\u0000${projectMappings[0].authoritative_id}`);
  }
  if (
    expected.size !== actual.size ||
    [...expected].some((identity) => !actual.has(identity))
  ) {
    throw new Error("Bootstrap identity mappings must cover every imported entity exactly once.");
  }
}

function parseBootstrapIdentityMapping(value: unknown): BootstrapIdentityMapping {
  const record = expectExactRecord(value, "bootstrap identity mapping", [
    "source_key",
    "identity_kind",
    "source_id",
    "disposition",
    "authoritative_id",
    "alias",
    "note"
  ]);
  const kind = expectEnum(
    record.identity_kind,
    bootstrapIdentityKinds,
    "bootstrap identity kind"
  );
  const sourceId = record.source_id === null
    ? null
    : expectString(record.source_id, "bootstrap source identity");
  const disposition = expectEnum(
    record.disposition,
    ["native_allocated", "trusted_adopt", "replace", "replace_and_alias"] as const,
    "bootstrap identity disposition"
  );
  const alias = record.alias === null ? null : parseLegacyIdentityAlias(record.alias);
  if (disposition === "native_allocated" && (sourceId !== null || alias !== null)) {
    throw new Error("A native identity mapping cannot contain legacy identity claims.");
  }
  if (disposition === "replace_and_alias" && alias === null) {
    throw new Error("A replace-and-alias identity mapping requires its exact alias.");
  }
  if (disposition === "trusted_adopt" && (sourceId === null || alias !== null)) {
    throw new Error("A trusted adoption requires source identity evidence and no alias.");
  }
  return freezeRecord({
    source_key: expectString(record.source_key, "bootstrap identity source key"),
    identity_kind: kind,
    source_id: sourceId,
    disposition,
    authoritative_id: parseEntityId(kind, record.authoritative_id),
    alias,
    note: record.note === null ? null : expectString(record.note, "bootstrap identity note")
  });
}

function parseGroup(value: unknown): BootstrapSharedGroup {
  const record = expectExactRecord(value, "bootstrap group", [
    "group_id",
    "title",
    "position"
  ]);
  return freezeRecord({
    group_id: parseEntityId("group", record.group_id),
    title: expectString(record.title, "bootstrap group title"),
    position: expectString(record.position, "bootstrap group position")
  });
}

function parseDocument(value: unknown): BootstrapSharedDocument {
  const record = expectExactRecord(value, "bootstrap document", [
    "document_id",
    "markdown_blob_id",
    "baseline_revision_id",
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
  const comments = parseUniqueArray(
    record.comments,
    "bootstrap comments",
    parseComment,
    (entry) => entry.comment_id,
    { allowEmpty: true, requireSorted: true }
  );
  const patches = parseUniqueArray(
    record.patches,
    "bootstrap patches",
    parsePatch,
    (entry) => entry.patch_id,
    { allowEmpty: true, requireSorted: true }
  );
  return freezeRecord({
    document_id: parseEntityId("document", record.document_id),
    markdown_blob_id: parseDigestId("markdown-blob", record.markdown_blob_id),
    baseline_revision_id: parseDigestId(
      "document-revision",
      record.baseline_revision_id
    ),
    title: expectString(record.title, "bootstrap document title"),
    logical_path: expectString(record.logical_path, "bootstrap document path"),
    position: expectString(record.position, "bootstrap document position"),
    group_id: record.group_id === null
      ? null
      : parseEntityId("group", record.group_id),
    archive_status: expectEnum(
      record.archive_status,
      ["active", "archived"] as const,
      "bootstrap document archive status"
    ),
    tombstone: parseBoolean(record.tombstone, "bootstrap document tombstone"),
    shared_roles: parseSortedUniqueStrings(
      record.shared_roles,
      "bootstrap document shared roles"
    ),
    comments,
    patches,
    reference_document_ids: parseSortedUniqueArray(
      record.reference_document_ids,
      "bootstrap document references",
      (entry) => parseEntityId("document", entry),
      { allowEmpty: true }
    )
  });
}

function parseMetadataEntry(value: unknown): BootstrapSharedMetadataEntry {
  const record = expectExactRecord(value, "bootstrap shared metadata", [
    "key",
    "value"
  ]);
  return freezeRecord({
    key: expectString(record.key, "bootstrap metadata key"),
    value: expectString(record.value, "bootstrap metadata value")
  });
}

function parseComment(value: unknown): BootstrapSharedComment {
  const record = expectExactRecord(value, "bootstrap comment", [
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
  const trashStatus = expectEnum(
    record.trash_status,
    ["active", "trashed"] as const,
    "bootstrap comment trash status"
  );
  const tombstone = parseBoolean(record.tombstone, "bootstrap comment tombstone");
  if (tombstone && trashStatus !== "active") {
    throw new Error("A permanently tombstoned bootstrap comment cannot remain reversibly trashed.");
  }
  return freezeRecord({
    comment_id: parseEntityId("comment", record.comment_id),
    body: expectString(record.body, "bootstrap comment body"),
    anchor: expectString(record.anchor, "bootstrap comment anchor"),
    status: expectEnum(
      record.status,
      ["open", "resolved"] as const,
      "bootstrap comment status"
    ),
    trash_status: trashStatus,
    tombstone,
    imported_provenance: parseNullableString(
      record.imported_provenance,
      "bootstrap comment provenance"
    ),
    imported_history: parseImportedHistory(record.imported_history),
    replies: parseUniqueArray(
      record.replies,
      "bootstrap replies",
      parseReply,
      (entry) => entry.reply_id,
      { allowEmpty: true, requireSorted: true }
    )
  });
}

function parseReply(value: unknown): BootstrapSharedReply {
  const record = expectExactRecord(value, "bootstrap reply", [
    "reply_id",
    "body",
    "tombstone",
    "imported_provenance",
    "imported_history"
  ]);
  return freezeRecord({
    reply_id: parseEntityId("reply", record.reply_id),
    body: expectString(record.body, "bootstrap reply body"),
    tombstone: parseBoolean(record.tombstone, "bootstrap reply tombstone"),
    imported_provenance: parseNullableString(
      record.imported_provenance,
      "bootstrap reply provenance"
    ),
    imported_history: parseImportedHistory(record.imported_history)
  });
}

function parseImportedHistory(value: unknown): readonly ImportedFieldHistoryEntry[] {
  const entries = expectArray(value, "imported field history").map((entry) => {
    const record = expectExactRecord(entry, "imported field history entry", [
      "field",
      "value",
      "advisory_order"
    ]);
    return freezeRecord({
      field: expectEnum(
        record.field,
        ["body", "anchor", "status"] as const,
        "imported history field"
      ),
      value: expectString(record.value, "imported history value"),
      advisory_order: expectCanonicalUInt64(record.advisory_order, "imported history order")
    });
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].advisory_order >= entries[index].advisory_order) {
      throw new Error("Imported field history must use strictly increasing advisory order.");
    }
  }
  return Object.freeze(entries);
}

function parsePatch(value: unknown): BootstrapSharedPatch {
  const record = expectExactRecord(value, "bootstrap patch", [
    "patch_id",
    "versions"
  ]);
  const versions = parseUniqueArray(
    record.versions,
    "bootstrap patch versions",
    parsePatchVersion,
    (entry) => entry.patch_version_id,
    { allowEmpty: false, requireSorted: true }
  );
  return freezeRecord({
    patch_id: parseEntityId("patch", record.patch_id),
    versions
  });
}

function parsePatchVersion(value: unknown): BootstrapSharedPatchVersion {
  const record = expectExactRecord(value, "bootstrap patch version", [
    "patch_version_id",
    "revision_id",
    "dependency_patch_version_ids",
    "decision",
    "target_provenance",
    "imported_provenance"
  ]);
  return freezeRecord({
    patch_version_id: parseEntityId("patch-version", record.patch_version_id),
    revision_id: record.revision_id === null
      ? null
      : parseDigestId("document-revision", record.revision_id),
    dependency_patch_version_ids: parseSortedUniqueArray(
      record.dependency_patch_version_ids,
      "bootstrap patch dependencies",
      (entry) => parseEntityId("patch-version", entry),
      { allowEmpty: true }
    ),
    decision: expectEnum(
      record.decision,
      ["pending", "accepted", "rejected"] as const,
      "bootstrap patch decision"
    ),
    target_provenance: parseNullableString(
      record.target_provenance,
      "bootstrap patch target provenance"
    ),
    imported_provenance: parseNullableString(
      record.imported_provenance,
      "bootstrap patch provenance"
    )
  });
}

function parseReviewBatch(value: unknown): BootstrapSharedReviewBatch {
  const record = expectExactRecord(value, "bootstrap review batch", [
    "review_batch_id",
    "lifecycle",
    "response_evidence_commitment",
    "response_import_id",
    "contribution_payload_ids",
    "imported_provenance"
  ]);
  const lifecycle = expectEnum(
    record.lifecycle,
    ["active", "responded", "cancelled"] as const,
    "bootstrap review lifecycle"
  );
  const commitment = record.response_evidence_commitment === null
    ? null
    : parseReviewResponseEvidenceCommitment(
        record.response_evidence_commitment
      );
  const responseImportId = record.response_import_id === null
    ? null
    : parseReviewResponseImportId(record.response_import_id);
  const contributions = parseReviewContributionPayloadIds(
    record.contribution_payload_ids
  );
  if (
    lifecycle === "responded"
      ? commitment === null || responseImportId === null
      : commitment !== null || responseImportId !== null || contributions.length > 0
  ) {
    throw new Error(
      "Only a responded bootstrap review may carry exact response evidence and contributions."
    );
  }
  return freezeRecord({
    review_batch_id: parseEntityId("review-batch", record.review_batch_id),
    lifecycle,
    response_evidence_commitment: commitment,
    response_import_id: responseImportId,
    contribution_payload_ids: contributions,
    imported_provenance: parseNullableString(
      record.imported_provenance,
      "bootstrap review provenance"
    )
  });
}

function parseRewriteSession(value: unknown): BootstrapSharedRewriteSession {
  const record = expectExactRecord(value, "bootstrap rewrite session", [
    "rewrite_session_id",
    "document_id",
    "outcome",
    "applied_revision_ids",
    "imported_provenance"
  ]);
  const outcome = expectEnum(
    record.outcome,
    ["active", "discarded", "applied"] as const,
    "bootstrap rewrite outcome"
  );
  const revisions = parseSortedUniqueArray(
    record.applied_revision_ids,
    "bootstrap rewrite revisions",
    (entry) => parseDigestId("document-revision", entry),
    { allowEmpty: true }
  );
  if ((outcome === "applied") !== (revisions.length > 0)) {
    throw new Error("Only an applied bootstrap rewrite may name applied revisions.");
  }
  return freezeRecord({
    rewrite_session_id: parseEntityId("rewrite-session", record.rewrite_session_id),
    document_id: parseEntityId("document", record.document_id),
    outcome,
    applied_revision_ids: revisions,
    imported_provenance: parseNullableString(
      record.imported_provenance,
      "bootstrap rewrite provenance"
    )
  });
}

function parseImportedLegacyVersion(value: unknown): ImportedLegacyVersion {
  const record = expectExactRecord(value, "imported legacy version", [
    "document_id",
    "markdown_blob_id",
    "advisory_order",
    "imported_provenance"
  ]);
  return freezeRecord({
    document_id: parseEntityId("document", record.document_id),
    markdown_blob_id: parseDigestId("markdown-blob", record.markdown_blob_id),
    advisory_order: expectCanonicalUInt64(record.advisory_order, "legacy version advisory order"),
    imported_provenance: expectString(
      record.imported_provenance,
      "legacy version provenance"
    )
  });
}

function parseOrderedRegistry<TKind extends "group" | "document">(
  value: unknown,
  kind: TKind,
  label: string,
  registered: ReadonlySet<string>
): readonly (TKind extends "group" ? GroupId : DocumentId)[] {
  const entries = expectArray(value, label).map((entry) => parseEntityId(kind, entry));
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${label} must contain unique IDs.`);
  }
  if (
    entries.length !== registered.size ||
    entries.some((entry) => !registered.has(entry))
  ) {
    throw new Error(`${label} must contain every registered ${kind} exactly once.`);
  }
  return Object.freeze(entries) as unknown as readonly (TKind extends "group" ? GroupId : DocumentId)[];
}

function validateDocumentRelationships(
  documents: readonly BootstrapSharedDocument[],
  groupIds: ReadonlySet<GroupId>,
  documentIds: ReadonlySet<DocumentId>
): void {
  const patchVersionIds = new Set<PatchVersionId>();
  for (const document of documents) {
    if (document.group_id !== null && !groupIds.has(document.group_id)) {
      throw new Error("Bootstrap document names an unregistered group.");
    }
    for (const target of document.reference_document_ids) {
      if (!documentIds.has(target)) {
        throw new Error("Bootstrap document reference names an unregistered document.");
      }
    }
    for (const patch of document.patches) {
      for (const version of patch.versions) {
        if (patchVersionIds.has(version.patch_version_id)) {
          throw new Error("Bootstrap patch-version identities must be project-wide unique.");
        }
        patchVersionIds.add(version.patch_version_id);
      }
    }
  }
  for (const document of documents) {
    for (const patch of document.patches) {
      for (const version of patch.versions) {
        for (const dependency of version.dependency_patch_version_ids) {
          if (!patchVersionIds.has(dependency) || dependency === version.patch_version_id) {
            throw new Error("Bootstrap patch dependency is missing or self-referential.");
          }
        }
      }
    }
  }
}

function aliasKey(alias: LegacyIdentityAlias): string {
  const scope = alias.scope;
  const suffix = scope.scope_kind === "project"
    ? scope.project_legacy_id
    : scope.scope_kind === "document"
      ? `${scope.project_legacy_id}\u0000${scope.document_legacy_id}`
      : `${scope.project_legacy_id}\u0000${scope.document_legacy_id}\u0000${scope.comment_legacy_id}`;
  return `${alias.identity_kind}\u0000${suffix}\u0000${alias.legacy_id}`;
}

function parseNullableString(value: unknown, label: string): string | null {
  return value === null ? null : expectString(value, label);
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function parseSortedUniqueStrings(value: unknown, label: string): readonly string[] {
  const entries = expectArray(value, label).map((entry) => expectString(entry, label));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1] >= entries[index]) {
      throw new Error(`${label} must be strictly sorted and unique.`);
    }
  }
  return Object.freeze(entries);
}

function expectCanonicalUInt64(value: unknown, label: string): UInt64 {
  return expectUInt64(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? BigInt(value)
      : value,
    label
  );
}

import {
  REVISION_CORE_SCHEMA_VERSION,
  REVISION_RECORD_VERSION
} from "./versions.ts";
import {
  type AcceptedHistoryRootId,
  type AttestationId,
  type DeviceId,
  type DocumentId,
  type DocumentRevisionId,
  type MarkdownBlobId,
  type ProjectId,
  type SemanticEventId,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  freezeRecord,
  parseSortedUniqueArray
} from "./validation.ts";

export type MarkdownBlobDescription = Readonly<{
  schema_version: 1;
  object_kind: "markdown_blob";
  project_id: ProjectId;
  blob_id: MarkdownBlobId;
  encoding: "utf-8-exact";
  bytes: Uint8Array;
}>;

export type GenesisRevisionCore = Readonly<{
  schema_version: typeof REVISION_CORE_SCHEMA_VERSION;
  object_kind: "document_revision_core";
  ancestry_kind: "genesis";
  project_id: ProjectId;
  document_id: DocumentId;
  markdown_blob_id: MarkdownBlobId;
  parent_revision_ids: readonly [];
}>;

export type OrdinaryRevisionCore = Readonly<{
  schema_version: typeof REVISION_CORE_SCHEMA_VERSION;
  object_kind: "document_revision_core";
  ancestry_kind: "ordinary";
  project_id: ProjectId;
  document_id: DocumentId;
  markdown_blob_id: MarkdownBlobId;
  parent_revision_ids: readonly DocumentRevisionId[];
}>;

export type AdmissionBoundaryRevisionCore = Readonly<{
  schema_version: typeof REVISION_CORE_SCHEMA_VERSION;
  object_kind: "document_revision_core";
  ancestry_kind: "admission_boundary";
  project_id: ProjectId;
  document_id: DocumentId;
  markdown_blob_id: MarkdownBlobId;
  parent_revision_ids: readonly DocumentRevisionId[];
  sealed_parent_history_root: AcceptedHistoryRootId;
  parent_traversal: "unavailable_before_admission";
  prior_plaintext: "not_provided";
}>;

export type DocumentRevisionCore =
  | GenesisRevisionCore
  | OrdinaryRevisionCore
  | AdmissionBoundaryRevisionCore;

export type DocumentRevisionRecord = Readonly<{
  record_version: typeof REVISION_RECORD_VERSION;
  object_kind: "document_revision";
  revision_id: DocumentRevisionId;
  core: DocumentRevisionCore;
}>;

export type RevisionAdoptionProvenance = Readonly<{
  schema_version: 1;
  provenance_kind: "revision_adoption";
  project_id: ProjectId;
  document_id: DocumentId;
  revision_id: DocumentRevisionId;
  adopting_event_id: SemanticEventId;
  author_device_id: DeviceId;
  author_attestation_id: AttestationId;
}>;

export function parseMarkdownBlobDescription(
  value: unknown
): MarkdownBlobDescription {
  const record = expectExactRecord(value, "Markdown blob description", [
    "schema_version",
    "object_kind",
    "project_id",
    "blob_id",
    "encoding",
    "bytes"
  ]);
  expectLiteral(record.schema_version, 1, "Markdown blob schema version");
  expectLiteral(record.object_kind, "markdown_blob", "Markdown blob object kind");
  expectLiteral(record.encoding, "utf-8-exact", "Markdown blob encoding");
  return freezeRecord({
    schema_version: 1,
    object_kind: "markdown_blob" as const,
    project_id: parseEntityId("project", record.project_id),
    blob_id: parseDigestId("markdown-blob", record.blob_id),
    encoding: "utf-8-exact" as const,
    bytes: expectBytes(record.bytes, "Markdown blob bytes")
  });
}

export function parseDocumentRevisionCore(
  value: unknown
): DocumentRevisionCore {
  const base = expectExactRecord(
    value,
    "document revision core",
    [
      "schema_version",
      "object_kind",
      "ancestry_kind",
      "project_id",
      "document_id",
      "markdown_blob_id",
      "parent_revision_ids"
    ],
    ["sealed_parent_history_root", "parent_traversal", "prior_plaintext"]
  );
  expectLiteral(
    base.schema_version,
    REVISION_CORE_SCHEMA_VERSION,
    "revision core schema version"
  );
  expectLiteral(
    base.object_kind,
    "document_revision_core",
    "revision core object kind"
  );
  const ancestryKind = expectEnum(
    base.ancestry_kind,
    ["genesis", "ordinary", "admission_boundary"] as const,
    "revision ancestry kind"
  );
  const projectId = parseEntityId("project", base.project_id);
  const documentId = parseEntityId("document", base.document_id);
  const markdownBlobId = parseDigestId("markdown-blob", base.markdown_blob_id);
  const parents = parseSortedUniqueArray(
    base.parent_revision_ids,
    "revision parent IDs",
    (candidate) => parseDigestId("document-revision", candidate),
    { allowEmpty: ancestryKind !== "ordinary" }
  );

  if (ancestryKind === "genesis") {
    assertNoBoundaryFields(base, "genesis revision");
    if (parents.length !== 0) {
      throw new Error("A genesis revision cannot have parents.");
    }
    return freezeRecord({
      schema_version: REVISION_CORE_SCHEMA_VERSION,
      object_kind: "document_revision_core" as const,
      ancestry_kind: "genesis" as const,
      project_id: projectId,
      document_id: documentId,
      markdown_blob_id: markdownBlobId,
      parent_revision_ids: Object.freeze([]) as readonly []
    });
  }

  if (ancestryKind === "ordinary") {
    assertNoBoundaryFields(base, "ordinary revision");
    return freezeRecord({
      schema_version: REVISION_CORE_SCHEMA_VERSION,
      object_kind: "document_revision_core" as const,
      ancestry_kind: "ordinary" as const,
      project_id: projectId,
      document_id: documentId,
      markdown_blob_id: markdownBlobId,
      parent_revision_ids: parents
    });
  }

  if (
    base.sealed_parent_history_root === undefined ||
    base.parent_traversal === undefined ||
    base.prior_plaintext === undefined
  ) {
    throw new Error("An admission-boundary revision requires sealed ancestry fields.");
  }
  expectLiteral(
    base.parent_traversal,
    "unavailable_before_admission",
    "admission parent traversal"
  );
  expectLiteral(
    base.prior_plaintext,
    "not_provided",
    "admission prior plaintext status"
  );
  return freezeRecord({
    schema_version: REVISION_CORE_SCHEMA_VERSION,
    object_kind: "document_revision_core" as const,
    ancestry_kind: "admission_boundary" as const,
    project_id: projectId,
    document_id: documentId,
    markdown_blob_id: markdownBlobId,
    parent_revision_ids: parents,
    sealed_parent_history_root: parseDigestId(
      "accepted-history-root",
      base.sealed_parent_history_root
    ),
    parent_traversal: "unavailable_before_admission" as const,
    prior_plaintext: "not_provided" as const
  });
}

export function parseDocumentRevisionRecord(
  value: unknown
): DocumentRevisionRecord {
  const record = expectExactRecord(value, "document revision record", [
    "record_version",
    "object_kind",
    "revision_id",
    "core"
  ]);
  expectLiteral(
    record.record_version,
    REVISION_RECORD_VERSION,
    "revision record version"
  );
  expectLiteral(
    record.object_kind,
    "document_revision",
    "revision record object kind"
  );
  return freezeRecord({
    record_version: REVISION_RECORD_VERSION,
    object_kind: "document_revision" as const,
    revision_id: parseDigestId("document-revision", record.revision_id),
    core: parseDocumentRevisionCore(record.core)
  });
}

export function parseRevisionAdoptionProvenance(
  value: unknown
): RevisionAdoptionProvenance {
  const record = expectExactRecord(value, "revision adoption provenance", [
    "schema_version",
    "provenance_kind",
    "project_id",
    "document_id",
    "revision_id",
    "adopting_event_id",
    "author_device_id",
    "author_attestation_id"
  ]);
  expectLiteral(record.schema_version, 1, "revision provenance version");
  expectLiteral(
    record.provenance_kind,
    "revision_adoption",
    "revision provenance kind"
  );
  return freezeRecord({
    schema_version: 1,
    provenance_kind: "revision_adoption" as const,
    project_id: parseEntityId("project", record.project_id),
    document_id: parseEntityId("document", record.document_id),
    revision_id: parseDigestId("document-revision", record.revision_id),
    adopting_event_id: parseDigestId("semantic-event", record.adopting_event_id),
    author_device_id: parseEntityId("device", record.author_device_id),
    author_attestation_id: parseDigestId(
      "attestation",
      record.author_attestation_id
    )
  });
}

function assertNoBoundaryFields(
  record: Readonly<Record<string, unknown>>,
  label: string
): void {
  for (const key of [
    "sealed_parent_history_root",
    "parent_traversal",
    "prior_plaintext"
  ]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${label} cannot contain ${key}.`);
    }
  }
}

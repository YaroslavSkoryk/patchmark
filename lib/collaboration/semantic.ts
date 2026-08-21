import {
  SEMANTIC_EVENT_CORE_SCHEMA_VERSION,
  SEMANTIC_EVENT_RECORD_VERSION,
  SEMANTIC_PAYLOAD_SCHEMA_VERSION
} from "./versions.ts";
import type { ConsolidationCheckpointPayload } from "./checkpoints.ts";
import { parseConsolidationCheckpointPayload } from "./checkpoints.ts";
import type { MergeAuthorization } from "./derived.ts";
import { parseMergeAuthorization } from "./derived.ts";
import {
  type AttestationId,
  type CommentId,
  type ControlEventId,
  type DerivedConflictId,
  type DeviceId,
  type DocumentId,
  type DocumentRevisionId,
  type GroupId,
  type KeyEpochId,
  type MarkdownBlobId,
  type PatchId,
  type PatchVersionId,
  type ProjectId,
  type ReplyId,
  type SemanticEventId,
  type SemanticPayloadId,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  type NonAuthoritativeTimestamp,
  type UInt64,
  expectDisplayTimestamp,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectPositiveUInt64,
  expectString,
  expectZeroUInt64,
  freezeRecord,
  parseSortedUniqueArray
} from "./validation.ts";

export const semanticKinds = [
  "project_genesis",
  "revision_adoption",
  "merge_revision_adoption",
  "external_revision_import",
  "comment_operation",
  "reply_operation",
  "patch_operation",
  "metadata_operation",
  "conflict_resolution",
  "consolidation_checkpoint"
] as const;

export type SemanticKind = (typeof semanticKinds)[number];

type SemanticPayloadBase<TKind extends SemanticKind, TData> = Readonly<{
  schema_version: typeof SEMANTIC_PAYLOAD_SCHEMA_VERSION;
  project_id: ProjectId;
  semantic_kind: TKind;
  data: Readonly<TData>;
}>;

export type ProjectGenesisPayload = SemanticPayloadBase<
  "project_genesis",
  {
    genesis_revision_ids: readonly DocumentRevisionId[];
  }
>;

export type RevisionAdoptionPayload = SemanticPayloadBase<
  "revision_adoption",
  {
    document_id: DocumentId;
    revision_id: DocumentRevisionId;
  }
>;

export type MergeRevisionAdoptionPayload = SemanticPayloadBase<
  "merge_revision_adoption",
  {
    document_id: DocumentId;
    revision_id: DocumentRevisionId;
    authorization: MergeAuthorization;
  }
>;

export type ExternalRevisionImportPayload = SemanticPayloadBase<
  "external_revision_import",
  {
    document_id: DocumentId;
    revision_id: DocumentRevisionId;
    imported_blob_id: MarkdownBlobId;
  }
>;

export type CommentOperationPayload = SemanticPayloadBase<
  "comment_operation",
  | {
      operation: "create" | "edit";
      document_id: DocumentId;
      comment_id: CommentId;
      content: string;
    }
  | {
      operation: "resolve" | "delete";
      document_id: DocumentId;
      comment_id: CommentId;
    }
>;

export type ReplyOperationPayload = SemanticPayloadBase<
  "reply_operation",
  | {
      operation: "create" | "edit";
      document_id: DocumentId;
      comment_id: CommentId;
      reply_id: ReplyId;
      content: string;
    }
  | {
      operation: "delete";
      document_id: DocumentId;
      comment_id: CommentId;
      reply_id: ReplyId;
    }
>;

export type PatchOperationPayload = SemanticPayloadBase<
  "patch_operation",
  | {
      operation: "propose" | "edit";
      document_id: DocumentId;
      patch_id: PatchId;
      patch_version_id: PatchVersionId;
    }
  | {
      operation: "decide";
      document_id: DocumentId;
      patch_id: PatchId;
      patch_version_id: PatchVersionId;
      decision: "accepted" | "rejected";
    }
>;

export type MetadataOperationPayload = SemanticPayloadBase<
  "metadata_operation",
  | {
      operation: "project_title";
      value: string;
    }
  | {
      operation: "document_create" | "document_archive" | "document_restore";
      document_id: DocumentId;
    }
  | {
      operation: "document_title" | "document_path";
      document_id: DocumentId;
      value: string;
    }
  | {
      operation: "group_create";
      group_id: GroupId;
      value: string;
    }
  | {
      operation: "group_rename";
      group_id: GroupId;
      value: string;
    }
>;

export type ConflictResolutionPayload = SemanticPayloadBase<
  "conflict_resolution",
  {
    conflict_id: DerivedConflictId;
    adopted_revision_id: DocumentRevisionId | null;
  }
>;

export type SemanticPayloadCore =
  | ProjectGenesisPayload
  | RevisionAdoptionPayload
  | MergeRevisionAdoptionPayload
  | ExternalRevisionImportPayload
  | CommentOperationPayload
  | ReplyOperationPayload
  | PatchOperationPayload
  | MetadataOperationPayload
  | ConflictResolutionPayload
  | ConsolidationCheckpointPayload;

export type SemanticPayloadRecord = Readonly<{
  record_version: 1;
  object_kind: "semantic_payload";
  payload_id: SemanticPayloadId;
  core: SemanticPayloadCore;
}>;

type SemanticEventCoreCommon = Readonly<{
  schema_version: typeof SEMANTIC_EVENT_CORE_SCHEMA_VERSION;
  object_kind: "semantic_event_core";
  project_id: ProjectId;
  semantic_kind: SemanticKind;
  author_device_id: DeviceId;
  device_sequence: UInt64;
  causal_parent_event_ids: readonly SemanticEventId[];
  authorizing_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  semantic_payload_id: SemanticPayloadId;
  complete_known_frontier: true;
  display_timestamp?: NonAuthoritativeTimestamp;
}>;

export type FirstDeviceSemanticEventCore = SemanticEventCoreCommon &
  Readonly<{
    device_chain_position: "first";
    previous_device_event_id: null;
  }>;

export type SubsequentSemanticEventCore = SemanticEventCoreCommon &
  Readonly<{
    device_chain_position: "subsequent";
    previous_device_event_id: SemanticEventId;
  }>;

export type SemanticEventCore =
  | FirstDeviceSemanticEventCore
  | SubsequentSemanticEventCore;

export type SemanticEventRecord = Readonly<{
  record_version: typeof SEMANTIC_EVENT_RECORD_VERSION;
  object_kind: "semantic_event";
  event_id: SemanticEventId;
  core: SemanticEventCore;
  author_attestation_ids: readonly AttestationId[];
}>;

export function parseSemanticPayloadCore(value: unknown): SemanticPayloadCore {
  const discriminator = expectExactRecord(
    value,
    "semantic payload core",
    ["schema_version", "project_id", "semantic_kind", "data"]
  );
  expectLiteral(
    discriminator.schema_version,
    SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    "semantic payload schema version"
  );
  const semanticKind = expectEnum(
    discriminator.semantic_kind,
    semanticKinds,
    "semantic payload kind"
  );
  if (semanticKind === "consolidation_checkpoint") {
    return parseConsolidationCheckpointPayload(value);
  }
  const projectId = parseEntityId("project", discriminator.project_id);
  const data = discriminator.data;
  switch (semanticKind) {
    case "project_genesis": {
      const body = expectExactRecord(data, "project genesis payload", [
        "genesis_revision_ids"
      ]);
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "project_genesis" as const,
        data: freezeRecord({
          genesis_revision_ids: parseSortedUniqueArray(
            body.genesis_revision_ids,
            "genesis revision IDs",
            (candidate) => parseDigestId("document-revision", candidate)
          )
        })
      });
    }
    case "revision_adoption": {
      const body = expectExactRecord(data, "revision adoption payload", [
        "document_id",
        "revision_id"
      ]);
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "revision_adoption" as const,
        data: freezeRecord({
          document_id: parseEntityId("document", body.document_id),
          revision_id: parseDigestId("document-revision", body.revision_id)
        })
      });
    }
    case "merge_revision_adoption": {
      const body = expectExactRecord(data, "merge adoption payload", [
        "document_id",
        "revision_id",
        "authorization"
      ]);
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "merge_revision_adoption" as const,
        data: freezeRecord({
          document_id: parseEntityId("document", body.document_id),
          revision_id: parseDigestId("document-revision", body.revision_id),
          authorization: parseMergeAuthorization(body.authorization)
        })
      });
    }
    case "external_revision_import": {
      const body = expectExactRecord(data, "external revision import payload", [
        "document_id",
        "revision_id",
        "imported_blob_id"
      ]);
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "external_revision_import" as const,
        data: freezeRecord({
          document_id: parseEntityId("document", body.document_id),
          revision_id: parseDigestId("document-revision", body.revision_id),
          imported_blob_id: parseDigestId("markdown-blob", body.imported_blob_id)
        })
      });
    }
    case "comment_operation":
      return parseCommentPayload(projectId, data);
    case "reply_operation":
      return parseReplyPayload(projectId, data);
    case "patch_operation":
      return parsePatchPayload(projectId, data);
    case "metadata_operation":
      return parseMetadataPayload(projectId, data);
    case "conflict_resolution": {
      const body = expectExactRecord(data, "conflict resolution payload", [
        "conflict_id",
        "adopted_revision_id"
      ]);
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "conflict_resolution" as const,
        data: freezeRecord({
          conflict_id: parseDigestId("derived-conflict", body.conflict_id),
          adopted_revision_id:
            body.adopted_revision_id === null
              ? null
              : parseDigestId("document-revision", body.adopted_revision_id)
        })
      });
    }
  }
}

export function parseSemanticPayloadRecord(
  value: unknown
): SemanticPayloadRecord {
  const record = expectExactRecord(value, "semantic payload record", [
    "record_version",
    "object_kind",
    "payload_id",
    "core"
  ]);
  expectLiteral(record.record_version, 1, "semantic payload record version");
  expectLiteral(
    record.object_kind,
    "semantic_payload",
    "semantic payload object kind"
  );
  return freezeRecord({
    record_version: 1,
    object_kind: "semantic_payload" as const,
    payload_id: parseDigestId("semantic-payload", record.payload_id),
    core: parseSemanticPayloadCore(record.core)
  });
}

export function parseSemanticEventCore(
  value: unknown,
  payload: SemanticPayloadRecord
): SemanticEventCore {
  const record = expectExactRecord(
    value,
    "semantic event core",
    [
      "schema_version",
      "object_kind",
      "device_chain_position",
      "project_id",
      "semantic_kind",
      "author_device_id",
      "device_sequence",
      "previous_device_event_id",
      "causal_parent_event_ids",
      "authorizing_control_head_id",
      "key_epoch_id",
      "semantic_payload_id",
      "complete_known_frontier"
    ],
    ["display_timestamp"]
  );
  expectLiteral(
    record.schema_version,
    SEMANTIC_EVENT_CORE_SCHEMA_VERSION,
    "semantic event core schema version"
  );
  expectLiteral(
    record.object_kind,
    "semantic_event_core",
    "semantic event core object kind"
  );
  expectLiteral(
    record.complete_known_frontier,
    true,
    "semantic event complete-known-frontier marker"
  );
  const position = expectEnum(
    record.device_chain_position,
    ["first", "subsequent"] as const,
    "semantic device-chain position"
  );
  const projectId = parseEntityId("project", record.project_id);
  const semanticKind = expectEnum(
    record.semantic_kind,
    semanticKinds,
    "semantic event kind"
  );
  const payloadId = parseDigestId("semantic-payload", record.semantic_payload_id);
  const parents = parseSortedUniqueArray(
    record.causal_parent_event_ids,
    "semantic causal-parent IDs",
    (candidate) => parseDigestId("semantic-event", candidate),
    { allowEmpty: position === "first" }
  );
  const common = {
    schema_version: SEMANTIC_EVENT_CORE_SCHEMA_VERSION,
    object_kind: "semantic_event_core" as const,
    project_id: projectId,
    semantic_kind: semanticKind,
    author_device_id: parseEntityId("device", record.author_device_id),
    causal_parent_event_ids: parents,
    authorizing_control_head_id: parseDigestId(
      "control-event",
      record.authorizing_control_head_id
    ),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    semantic_payload_id: payloadId,
    complete_known_frontier: true as const,
    ...(record.display_timestamp === undefined
      ? {}
      : {
          display_timestamp: expectDisplayTimestamp(
            record.display_timestamp,
            "semantic event display timestamp"
          )
        })
  };

  let core: SemanticEventCore;
  if (position === "first") {
    expectLiteral(
      record.previous_device_event_id,
      null,
      "first semantic event previous-device ID"
    );
    if (semanticKind === "project_genesis" && parents.length !== 0) {
      throw new Error("Project genesis cannot have causal parents.");
    }
    if (semanticKind !== "project_genesis" && parents.length === 0) {
      throw new Error(
        "A new device's first non-genesis event must declare its known frontier."
      );
    }
    core = freezeRecord({
      ...common,
      device_chain_position: "first" as const,
      device_sequence: expectZeroUInt64(
        record.device_sequence,
        "first semantic event sequence"
      ),
      previous_device_event_id: null
    });
  } else {
    const previousId = parseDigestId(
      "semantic-event",
      record.previous_device_event_id
    );
    if (!parents.includes(previousId)) {
      throw new Error(
        "A subsequent semantic event must include its previous device event among its causal parents."
      );
    }
    if (semanticKind === "project_genesis") {
      throw new Error("Project genesis must be a first device event.");
    }
    core = freezeRecord({
      ...common,
      device_chain_position: "subsequent" as const,
      device_sequence: expectPositiveUInt64(
        record.device_sequence,
        "subsequent semantic event sequence"
      ),
      previous_device_event_id: previousId
    });
  }

  assertEventPayloadMatch(core, payload);
  return core;
}

export function parseSemanticEventRecord(
  value: unknown,
  payload: SemanticPayloadRecord
): SemanticEventRecord {
  const record = expectExactRecord(value, "semantic event record", [
    "record_version",
    "object_kind",
    "event_id",
    "core",
    "author_attestation_ids"
  ]);
  expectLiteral(
    record.record_version,
    SEMANTIC_EVENT_RECORD_VERSION,
    "semantic event record version"
  );
  expectLiteral(
    record.object_kind,
    "semantic_event",
    "semantic event record kind"
  );
  const eventId = parseDigestId("semantic-event", record.event_id);
  const core = parseSemanticEventCore(record.core, payload);
  if (
    core.previous_device_event_id === eventId ||
    core.causal_parent_event_ids.includes(eventId)
  ) {
    throw new Error("A semantic event cannot reference itself.");
  }
  return freezeRecord({
    record_version: SEMANTIC_EVENT_RECORD_VERSION,
    object_kind: "semantic_event" as const,
    event_id: eventId,
    core,
    author_attestation_ids: parseSortedUniqueArray(
      record.author_attestation_ids,
      "semantic event author attestations",
      (candidate) => parseDigestId("attestation", candidate)
    )
  });
}

export function assertEventPayloadMatch(
  event: SemanticEventCore,
  payload: SemanticPayloadRecord
): void {
  if (event.semantic_payload_id !== payload.payload_id) {
    throw new Error("Semantic event payload ID does not match the payload record.");
  }
  if (event.project_id !== payload.core.project_id) {
    throw new Error("Semantic event and payload project IDs must match.");
  }
  if (event.semantic_kind !== payload.core.semantic_kind) {
    throw new Error("Semantic event and payload kinds must match.");
  }
}

function parseCommentPayload(
  projectId: ProjectId,
  value: unknown
): CommentOperationPayload {
  const body = expectExactRecord(
    value,
    "comment operation payload",
    ["operation", "document_id", "comment_id"],
    ["content"]
  );
  const operation = expectEnum(
    body.operation,
    ["create", "edit", "resolve", "delete"] as const,
    "comment operation"
  );
  const common = {
    document_id: parseEntityId("document", body.document_id),
    comment_id: parseEntityId("comment", body.comment_id)
  };
  if (operation === "create" || operation === "edit") {
    requirePresent(body, "content", "comment operation");
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "comment_operation" as const,
      data: freezeRecord({
        ...common,
        operation,
        content: expectString(body.content, "comment content")
      })
    });
  }
  requireAbsent(body, "content", "comment operation");
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "comment_operation" as const,
    data: freezeRecord({ ...common, operation })
  });
}

function parseReplyPayload(
  projectId: ProjectId,
  value: unknown
): ReplyOperationPayload {
  const body = expectExactRecord(
    value,
    "reply operation payload",
    ["operation", "document_id", "comment_id", "reply_id"],
    ["content"]
  );
  const operation = expectEnum(
    body.operation,
    ["create", "edit", "delete"] as const,
    "reply operation"
  );
  const common = {
    document_id: parseEntityId("document", body.document_id),
    comment_id: parseEntityId("comment", body.comment_id),
    reply_id: parseEntityId("reply", body.reply_id)
  };
  if (operation === "create" || operation === "edit") {
    requirePresent(body, "content", "reply operation");
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "reply_operation" as const,
      data: freezeRecord({
        ...common,
        operation,
        content: expectString(body.content, "reply content")
      })
    });
  }
  requireAbsent(body, "content", "reply operation");
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "reply_operation" as const,
    data: freezeRecord({ ...common, operation })
  });
}

function parsePatchPayload(
  projectId: ProjectId,
  value: unknown
): PatchOperationPayload {
  const body = expectExactRecord(
    value,
    "patch operation payload",
    ["operation", "document_id", "patch_id", "patch_version_id"],
    ["decision"]
  );
  const operation = expectEnum(
    body.operation,
    ["propose", "edit", "decide"] as const,
    "patch operation"
  );
  const common = {
    document_id: parseEntityId("document", body.document_id),
    patch_id: parseEntityId("patch", body.patch_id),
    patch_version_id: parseEntityId("patch-version", body.patch_version_id)
  };
  if (operation === "decide") {
    requirePresent(body, "decision", "patch decision");
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "patch_operation" as const,
      data: freezeRecord({
        ...common,
        operation: "decide" as const,
        decision: expectEnum(
          body.decision,
          ["accepted", "rejected"] as const,
          "patch decision"
        )
      })
    });
  }
  requireAbsent(body, "decision", "patch proposal or edit");
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "patch_operation" as const,
    data: freezeRecord({ ...common, operation })
  });
}

function parseMetadataPayload(
  projectId: ProjectId,
  value: unknown
): MetadataOperationPayload {
  const body = expectExactRecord(
    value,
    "metadata operation payload",
    ["operation"],
    ["document_id", "group_id", "value"]
  );
  const operation = expectEnum(
    body.operation,
    [
      "project_title",
      "document_create",
      "document_archive",
      "document_restore",
      "document_title",
      "document_path",
      "group_create",
      "group_rename"
    ] as const,
    "metadata operation"
  );
  if (operation === "project_title") {
    requireOnly(body, ["value"], "project-title operation");
    return metadataPayload(projectId, {
      operation,
      value: expectString(body.value, "project title")
    });
  }
  if (
    operation === "document_create" ||
    operation === "document_archive" ||
    operation === "document_restore"
  ) {
    requireOnly(body, ["document_id"], "document status operation");
    return metadataPayload(projectId, {
      operation,
      document_id: parseEntityId("document", body.document_id)
    });
  }
  if (operation === "document_title" || operation === "document_path") {
    requireOnly(body, ["document_id", "value"], "document metadata operation");
    return metadataPayload(projectId, {
      operation,
      document_id: parseEntityId("document", body.document_id),
      value: expectString(body.value, "document metadata value")
    });
  }
  requireOnly(body, ["group_id", "value"], "group metadata operation");
  return metadataPayload(projectId, {
    operation,
    group_id: parseEntityId("group", body.group_id),
    value: expectString(body.value, "group metadata value")
  });
}

function metadataPayload<TData extends MetadataOperationPayload["data"]>(
  projectId: ProjectId,
  data: TData
): MetadataOperationPayload {
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "metadata_operation" as const,
    data: freezeRecord(data)
  });
}

function requirePresent(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): void {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`${label} requires ${key}.`);
  }
}

function requireAbsent(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): void {
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`${label} cannot contain ${key}.`);
  }
}

function requireOnly(
  record: Readonly<Record<string, unknown>>,
  variantKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(["operation", ...variantKeys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} cannot contain ${key}.`);
    }
  }
  for (const key of variantKeys) {
    requirePresent(record, key, label);
  }
}

import {
  SEMANTIC_EVENT_CORE_SCHEMA_VERSION,
  SEMANTIC_EVENT_RECORD_VERSION,
  SEMANTIC_PAYLOAD_SCHEMA_VERSION
} from "./versions.ts";
import type { ConsolidationCheckpointPayload } from "./checkpoints.ts";
import { parseConsolidationCheckpointPayload } from "./checkpoints.ts";
import {
  parseCollaborationBootstrapImportData,
  type CollaborationBootstrapImportData
} from "./bootstrap-semantic.ts";
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
  type ReviewBatchId,
  type ReplyId,
  type RewriteSessionId,
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
import {
  parseReviewContributionPayloadIds,
  parseReviewResponseEvidenceCommitment,
  parseReviewResponseImportId,
  type ReviewResponseEvidenceCommitment,
  type ReviewResponseImportId
} from "./review-response-evidence.ts";

export const semanticKinds = [
  "project_genesis",
  "collaboration_bootstrap_import",
  "revision_adoption",
  "merge_revision_adoption",
  "external_revision_import",
  "comment_operation",
  "reply_operation",
  "patch_operation",
  "metadata_operation",
  "review_batch_operation",
  "rewrite_operation",
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

export type CollaborationBootstrapImportPayload = SemanticPayloadBase<
  "collaboration_bootstrap_import",
  CollaborationBootstrapImportData
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

export type SharedCommentAnchor =
  | Readonly<{
      anchor_kind: "document";
      anchor_key: "document";
    }>
  | Readonly<{
      anchor_kind: "section" | "selected_text";
      anchor_key: string;
    }>;

export type CommentOperationPayload = SemanticPayloadBase<
  "comment_operation",
  | {
      operation: "create";
      document_id: DocumentId;
      comment_id: CommentId;
      content: string;
      anchor?: SharedCommentAnchor;
    }
  | {
      operation: "edit";
      document_id: DocumentId;
      comment_id: CommentId;
      content: string;
    }
  | {
      operation: "resolve" | "reopen" | "trash" | "restore" | "delete";
      document_id: DocumentId;
      comment_id: CommentId;
    }
  | {
      operation: "reanchor";
      document_id: DocumentId;
      comment_id: CommentId;
      anchor: SharedCommentAnchor;
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
      review_batch_id?: ReviewBatchId;
      response_import_id?: ReviewResponseImportId;
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
      revision_id?: DocumentRevisionId;
      dependency_patch_version_ids?: readonly PatchVersionId[];
      target_provenance?: string;
      review_batch_id?: ReviewBatchId;
      response_import_id?: ReviewResponseImportId;
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
      operation:
        | "document_create"
        | "document_archive"
        | "document_restore"
        | "document_delete";
      document_id: DocumentId;
    }
  | {
      operation: "document_title" | "document_path";
      document_id: DocumentId;
      value: string;
    }
  | {
      operation: "document_position";
      document_id: DocumentId;
      value: string;
    }
  | {
      operation: "document_group";
      document_id: DocumentId;
      group_id: GroupId;
    }
  | {
      operation: "document_reference";
      document_id: DocumentId;
      target_document_id: DocumentId;
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
  | {
      operation: "group_position";
      group_id: GroupId;
      value: string;
    }
>;

export type ReviewBatchOperationPayload = SemanticPayloadBase<
  "review_batch_operation",
  | {
      operation: "create";
      review_batch_id: ReviewBatchId;
    }
  | {
      operation: "respond";
      review_batch_id: ReviewBatchId;
      response_evidence_commitment: ReviewResponseEvidenceCommitment;
      response_import_id: ReviewResponseImportId;
      contribution_payload_ids: readonly SemanticPayloadId[];
    }
  | {
      operation: "cancel";
      review_batch_id: ReviewBatchId;
    }
>;

export type RewriteOperationPayload = SemanticPayloadBase<
  "rewrite_operation",
  | {
      operation: "create" | "discard";
      document_id: DocumentId;
      rewrite_session_id: RewriteSessionId;
    }
  | {
      operation: "apply";
      document_id: DocumentId;
      rewrite_session_id: RewriteSessionId;
      revision_id: DocumentRevisionId;
    }
>;

export type ConflictResolutionPayload = SemanticPayloadBase<
  "conflict_resolution",
  {
    conflict_id: DerivedConflictId;
    adopted_revision_id: DocumentRevisionId | null;
    observed_contender_event_ids?: readonly SemanticEventId[];
    adopted_event_id?: SemanticEventId | null;
  }
>;

export type SemanticPayloadCore =
  | ProjectGenesisPayload
  | CollaborationBootstrapImportPayload
  | RevisionAdoptionPayload
  | MergeRevisionAdoptionPayload
  | ExternalRevisionImportPayload
  | CommentOperationPayload
  | ReplyOperationPayload
  | PatchOperationPayload
  | MetadataOperationPayload
  | ReviewBatchOperationPayload
  | RewriteOperationPayload
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
    case "collaboration_bootstrap_import": {
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "collaboration_bootstrap_import" as const,
        data: parseCollaborationBootstrapImportData(data, projectId)
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
    case "review_batch_operation":
      return parseReviewBatchPayload(projectId, data);
    case "rewrite_operation":
      return parseRewritePayload(projectId, data);
    case "conflict_resolution": {
      const body = expectExactRecord(
        data,
        "conflict resolution payload",
        ["conflict_id", "adopted_revision_id"],
        ["observed_contender_event_ids", "adopted_event_id"]
      );
      return freezeRecord({
        schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
        project_id: projectId,
        semantic_kind: "conflict_resolution" as const,
        data: freezeRecord({
          conflict_id: parseDigestId("derived-conflict", body.conflict_id),
          adopted_revision_id:
            body.adopted_revision_id === null
              ? null
              : parseDigestId("document-revision", body.adopted_revision_id),
          ...(body.observed_contender_event_ids === undefined
            ? {}
            : {
                observed_contender_event_ids: parseSortedUniqueArray(
                  body.observed_contender_event_ids,
                  "observed conflict contender event IDs",
                  (candidate) => parseDigestId("semantic-event", candidate)
                )
              }),
          ...(body.adopted_event_id === undefined
            ? {}
            : {
                adopted_event_id:
                  body.adopted_event_id === null
                    ? null
                    : parseDigestId("semantic-event", body.adopted_event_id)
              })
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

/**
 * Parses only the immutable semantic-event core shape. Dependency-aware
 * callers must use parseSemanticEventCore so payload ownership and kind are
 * checked before the event is accepted.
 */
export function parseSemanticEventCoreStructure(
  value: unknown
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
    const isGenesisBoundary =
      semanticKind === "project_genesis" ||
      semanticKind === "collaboration_bootstrap_import";
    if (isGenesisBoundary && parents.length !== 0) {
      throw new Error("A semantic genesis boundary cannot have causal parents.");
    }
    if (!isGenesisBoundary && parents.length === 0) {
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
    if (
      semanticKind === "project_genesis" ||
      semanticKind === "collaboration_bootstrap_import"
    ) {
      throw new Error("A semantic genesis boundary must be a first device event.");
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

  return core;
}

export function parseSemanticEventCore(
  value: unknown,
  payload: SemanticPayloadRecord
): SemanticEventCore {
  const core = parseSemanticEventCoreStructure(value);
  assertEventPayloadMatch(core, payload);
  return core;
}

export function parseSemanticEventRecord(
  value: unknown,
  payload: SemanticPayloadRecord
): SemanticEventRecord {
  const parsed = parseSemanticEventRecordStructure(value);
  assertEventPayloadMatch(parsed.core, payload);
  return parsed;
}

export function parseSemanticEventRecordStructure(
  value: unknown
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
  const core = parseSemanticEventCoreStructure(record.core);
  if (
    core.previous_device_event_id === eventId ||
    core.causal_parent_event_ids.includes(eventId)
  ) {
    throw new Error("A semantic event cannot reference itself.");
  }
  const authorAttestationIds = parseSortedUniqueArray(
    record.author_attestation_ids,
    "semantic event author attestations",
    (candidate) => parseDigestId("attestation", candidate)
  );
  if (authorAttestationIds.length !== 1) {
    throw new Error("A semantic event record must contain exactly one mandatory author attestation.");
  }
  return freezeRecord({
    record_version: SEMANTIC_EVENT_RECORD_VERSION,
    object_kind: "semantic_event" as const,
    event_id: eventId,
    core,
    author_attestation_ids: authorAttestationIds
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
    ["content", "anchor"]
  );
  const operation = expectEnum(
    body.operation,
    ["create", "edit", "resolve", "reopen", "reanchor", "trash", "restore", "delete"] as const,
    "comment operation"
  );
  const common = {
    document_id: parseEntityId("document", body.document_id),
    comment_id: parseEntityId("comment", body.comment_id)
  };
  if (operation === "create" || operation === "edit") {
    requirePresent(body, "content", "comment operation");
    if (operation === "edit") requireAbsent(body, "anchor", "comment edit");
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "comment_operation" as const,
      data: freezeRecord({
        ...common,
        operation,
        content: expectString(body.content, "comment content"),
        ...(body.anchor === undefined
          ? {}
          : { anchor: parseSharedCommentAnchor(body.anchor) })
      })
    });
  }
  requireAbsent(body, "content", "comment operation");
  if (operation === "reanchor") {
    requirePresent(body, "anchor", "comment re-anchor");
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "comment_operation" as const,
      data: freezeRecord({
        ...common,
        operation,
        anchor: parseSharedCommentAnchor(body.anchor)
      })
    });
  }
  requireAbsent(body, "anchor", "comment status operation");
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
    ["content", "review_batch_id", "response_import_id"]
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
    const reviewProvenance = parseReviewContributionProvenance(
      body,
      "reply operation"
    );
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "reply_operation" as const,
      data: freezeRecord({
        ...common,
        operation,
        content: expectString(body.content, "reply content"),
        ...reviewProvenance
      })
    });
  }
  requireAbsent(body, "content", "reply operation");
  requireAbsent(body, "review_batch_id", "reply deletion");
  requireAbsent(body, "response_import_id", "reply deletion");
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
    [
      "decision",
      "revision_id",
      "dependency_patch_version_ids",
      "target_provenance",
      "review_batch_id",
      "response_import_id"
    ]
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
    requireAbsent(body, "revision_id", "patch decision");
    requireAbsent(body, "dependency_patch_version_ids", "patch decision");
    requireAbsent(body, "target_provenance", "patch decision");
    requireAbsent(body, "review_batch_id", "patch decision");
    requireAbsent(body, "response_import_id", "patch decision");
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
  const reviewProvenance = parseReviewContributionProvenance(
    body,
    "patch proposal or edit"
  );
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "patch_operation" as const,
    data: freezeRecord({
      ...common,
      operation,
      ...reviewProvenance,
      ...(body.revision_id === undefined
        ? {}
        : {
            revision_id: parseDigestId(
              "document-revision",
              body.revision_id
            )
          }),
      ...(body.dependency_patch_version_ids === undefined
        ? {}
        : {
            dependency_patch_version_ids: parseSortedUniqueArray(
              body.dependency_patch_version_ids,
              "patch dependency version IDs",
              (candidate) => parseEntityId("patch-version", candidate),
              { allowEmpty: true }
            )
          }),
      ...(body.target_provenance === undefined
        ? {}
        : {
            target_provenance: expectString(
              body.target_provenance,
              "patch target provenance"
            )
          })
    })
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
    ["document_id", "group_id", "target_document_id", "value"]
  );
  const operation = expectEnum(
    body.operation,
    [
      "project_title",
      "document_create",
      "document_archive",
      "document_restore",
      "document_delete",
      "document_title",
      "document_path",
      "document_position",
      "document_group",
      "document_reference",
      "group_create",
      "group_rename",
      "group_position"
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
    operation === "document_restore" ||
    operation === "document_delete"
  ) {
    requireOnly(body, ["document_id"], "document status operation");
    return metadataPayload(projectId, {
      operation,
      document_id: parseEntityId("document", body.document_id)
    });
  }
  if (
    operation === "document_title" ||
    operation === "document_path" ||
    operation === "document_position"
  ) {
    requireOnly(body, ["document_id", "value"], "document metadata operation");
    return metadataPayload(projectId, {
      operation,
      document_id: parseEntityId("document", body.document_id),
      value: expectString(body.value, "document metadata value")
    });
  }
  if (operation === "document_group") {
    requireOnly(body, ["document_id", "group_id"], "document group operation");
    return metadataPayload(projectId, {
      operation,
      document_id: parseEntityId("document", body.document_id),
      group_id: parseEntityId("group", body.group_id)
    });
  }
  if (operation === "document_reference") {
    requireOnly(
      body,
      ["document_id", "target_document_id"],
      "document reference operation"
    );
    return metadataPayload(projectId, {
      operation,
      document_id: parseEntityId("document", body.document_id),
      target_document_id: parseEntityId("document", body.target_document_id)
    });
  }
  requireOnly(body, ["group_id", "value"], "group metadata operation");
  return metadataPayload(projectId, {
    operation,
    group_id: parseEntityId("group", body.group_id),
    value: expectString(body.value, "group metadata value")
  });
}

function parseReviewBatchPayload(
  projectId: ProjectId,
  value: unknown
): ReviewBatchOperationPayload {
  const body = expectExactRecord(
    value,
    "review batch operation payload",
    ["operation", "review_batch_id"],
    [
      "response_evidence_commitment",
      "response_import_id",
      "contribution_payload_ids"
    ]
  );
  const operation = expectEnum(
    body.operation,
    ["create", "respond", "cancel"] as const,
    "review batch operation"
  );
  const reviewBatchId = parseEntityId("review-batch", body.review_batch_id);
  if (operation === "respond") {
    requirePresent(
      body,
      "response_evidence_commitment",
      "review batch response"
    );
    requirePresent(body, "response_import_id", "review batch response");
    requirePresent(
      body,
      "contribution_payload_ids",
      "review batch response"
    );
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "review_batch_operation" as const,
      data: freezeRecord({
        operation,
        review_batch_id: reviewBatchId,
        response_evidence_commitment:
          parseReviewResponseEvidenceCommitment(
            body.response_evidence_commitment
          ),
        response_import_id: parseReviewResponseImportId(
          body.response_import_id
        ),
        contribution_payload_ids: parseReviewContributionPayloadIds(
          body.contribution_payload_ids
        )
      })
    });
  }
  requireAbsent(
    body,
    "response_evidence_commitment",
    "review batch lifecycle operation"
  );
  requireAbsent(body, "response_import_id", "review batch lifecycle operation");
  requireAbsent(
    body,
    "contribution_payload_ids",
    "review batch lifecycle operation"
  );
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "review_batch_operation" as const,
    data: freezeRecord({ operation, review_batch_id: reviewBatchId })
  });
}

function parseReviewContributionProvenance(
  body: Readonly<Record<string, unknown>>,
  label: string
): Readonly<{
  review_batch_id?: ReviewBatchId;
  response_import_id?: ReviewResponseImportId;
}> {
  const hasReview = body.review_batch_id !== undefined;
  const hasImport = body.response_import_id !== undefined;
  if (hasReview !== hasImport) {
    throw new Error(
      `${label} review_batch_id and response_import_id must appear together.`
    );
  }
  return hasReview
    ? freezeRecord({
        review_batch_id: parseEntityId("review-batch", body.review_batch_id),
        response_import_id: parseReviewResponseImportId(
          body.response_import_id
        )
      })
    : freezeRecord({});
}

function parseRewritePayload(
  projectId: ProjectId,
  value: unknown
): RewriteOperationPayload {
  const body = expectExactRecord(
    value,
    "rewrite operation payload",
    ["operation", "document_id", "rewrite_session_id"],
    ["revision_id"]
  );
  const operation = expectEnum(
    body.operation,
    ["create", "apply", "discard"] as const,
    "rewrite operation"
  );
  const common = {
    document_id: parseEntityId("document", body.document_id),
    rewrite_session_id: parseEntityId(
      "rewrite-session",
      body.rewrite_session_id
    )
  };
  if (operation === "apply") {
    requirePresent(body, "revision_id", "rewrite apply operation");
    return freezeRecord({
      schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
      project_id: projectId,
      semantic_kind: "rewrite_operation" as const,
      data: freezeRecord({
        ...common,
        operation,
        revision_id: parseDigestId("document-revision", body.revision_id)
      })
    });
  }
  requireAbsent(body, "revision_id", "rewrite lifecycle operation");
  return freezeRecord({
    schema_version: SEMANTIC_PAYLOAD_SCHEMA_VERSION,
    project_id: projectId,
    semantic_kind: "rewrite_operation" as const,
    data: freezeRecord({ ...common, operation })
  });
}

function parseSharedCommentAnchor(value: unknown): SharedCommentAnchor {
  const record = expectExactRecord(value, "shared comment anchor", [
    "anchor_kind",
    "anchor_key"
  ]);
  const anchorKind = expectEnum(
    record.anchor_kind,
    ["document", "section", "selected_text"] as const,
    "shared comment anchor kind"
  );
  const anchorKey = expectString(record.anchor_key, "shared comment anchor key");
  if (anchorKind === "document" && anchorKey !== "document") {
    throw new Error("A document anchor must use the document anchor key.");
  }
  if (anchorKind === "document") {
    return freezeRecord({
      anchor_kind: "document" as const,
      anchor_key: "document" as const
    });
  }
  if (anchorKey.length === 0) {
    throw new Error("A scoped comment anchor key must not be empty.");
  }
  return freezeRecord({ anchor_kind: anchorKind, anchor_key: anchorKey });
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

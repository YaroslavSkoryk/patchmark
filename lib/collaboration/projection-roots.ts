import {
  canonicalArray,
  canonicalBytes,
  canonicalMap,
  canonicalText,
  canonicalUint,
  encodeCanonicalCbor,
  type CanonicalValue
} from "./canonical-cbor.ts";
import { canonicalProtocolValue } from "./canonical-protocol.ts";
import type { CollaborationCapability, CollaborationRole } from "./capabilities.ts";
import type { CheckpointResolutionOperation } from "./checkpoints.ts";
import { deriveDerivedConflictIdentity } from "./preimages.ts";
import { digestBytesFromId, formatDigestId } from "./digest-ids.ts";
import { collaborationHashDomains } from "./domains.ts";
import type { DeviceAuthorityFact } from "./event-control-types.ts";
import type {
  AcceptedHistoryRootId,
  ConflictSetRootId,
  ControlEventId,
  ControlStateRootId,
  DeviceId,
  FrontierRootId,
  KeyEpochCommitmentId,
  KeyEpochId,
  PersonId,
  ProjectId,
  ProjectionRootId,
  PublicKeyId,
  RevisionHeadsRootId,
  SemanticEventId,
  SemanticStateRootId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import { calculateMerkleMap, calculateMerkleSet, type PatchmarkMerkleRoot } from "./merkle.ts";
import type { LoadedProjectionHistory } from "./projection-causality.ts";
import {
  loadVerifiedRevisionGraph,
  type RevisionReadBoundary
} from "./projection-revisions.ts";
import {
  parseCollaborationProjection,
  type CollaborationProjection,
  type ProjectedTombstone,
  type ProjectedValueRegister
} from "./projection-types.ts";
import { parseSha256Digest, sha256, type Sha256Digest } from "./sha256.ts";
import { expectEnum, expectLiteral, expectUInt64, type UInt64 } from "./validation.ts";
import { INITIAL_REDUCER_VERSION } from "./versions.ts";

export type TypedMerkleRoot<TId extends string> = Readonly<{
  id: TId;
  merkle: PatchmarkMerkleRoot;
}>;

export async function deriveBaseFrontierRoot(
  frontier: readonly SemanticEventId[]
): Promise<TypedMerkleRoot<FrontierRootId>> {
  const parsed = sortedUniqueParsed(frontier, "semantic-event", "base frontier");
  const merkle = await calculateMerkleSet(
    "base_frontier",
    parsed.map((eventId) => ({ key: canonicalText(eventId) }))
  );
  return typedRoot("frontier-root", merkle);
}

export async function deriveAcceptedHistoryRoot(
  history: LoadedProjectionHistory
): Promise<TypedMerkleRoot<AcceptedHistoryRootId>> {
  const entries = history.events.map((loaded) => {
    if (loaded.event.author_attestation_ids.length !== 1) {
      throw new Error(
        `Accepted event ${loaded.event.event_id} does not establish one unambiguous mandatory author attestation.`
      );
    }
    return {
      key: canonicalText(loaded.event.event_id),
      value: canonicalText(loaded.event.author_attestation_ids[0])
    };
  });
  const merkle = await calculateMerkleMap("accepted_history", entries);
  return typedRoot("accepted-history-root", merkle);
}

export async function deriveSemanticStateRoot(
  value: CollaborationProjection
): Promise<TypedMerkleRoot<SemanticStateRootId>> {
  const projection = parseCollaborationProjection(value);
  const entries: Array<{ key: CanonicalValue; value: CanonicalValue }> = [
    semanticEntry("project", projection.project_id, {
      project_id: projection.project_id,
      title: semanticRegister(projection.project_title),
      group_order: [...projection.group_order],
      document_order: [...projection.document_order]
    })
  ];
  if (projection.bootstrap_import !== undefined) {
    entries.push(semanticEntry("bootstrap_import", projection.project_id, {
      boundary_event_id: projection.bootstrap_import.boundary_event_id,
      boundary_payload_id: projection.bootstrap_import.boundary_payload_id,
      data: projection.bootstrap_import.data
    }));
  }
  for (const group of projection.groups) {
    entries.push(semanticEntry("group", group.group_id, {
      group_id: group.group_id,
      title: semanticRegister(group.title),
      position: semanticRegister(group.position)
    }));
  }
  for (const document of projection.documents) {
    entries.push(semanticEntry("document", document.document_id, {
      document_id: document.document_id,
      title: semanticRegister(document.title),
      logical_path: semanticRegister(document.logical_path),
      position: semanticRegister(document.position),
      group: semanticRegister(document.group),
      archive_status: semanticRegister(document.archive_status),
      tombstone: semanticTombstone(document.tombstone),
      comments: document.comments.map((comment) => ({
        comment_id: comment.comment_id,
        document_id: comment.document_id,
        body: semanticRegister(comment.body),
        anchor: semanticRegister(comment.anchor),
        status: semanticRegister(comment.status),
        ...(comment.trash_status === undefined
          ? {}
          : { trash_status: semanticRegister(comment.trash_status) }),
        tombstone: semanticTombstone(comment.tombstone),
        replies: comment.replies.map((reply) => ({
          reply_id: reply.reply_id,
          comment_id: reply.comment_id,
          document_id: reply.document_id,
          body: semanticRegister(reply.body),
          tombstone: semanticTombstone(reply.tombstone)
        }))
      })),
      patches: document.patches.map((patch) => ({
        patch_id: patch.patch_id,
        document_id: patch.document_id,
        versions: patch.versions.map((version) => ({
          patch_version_id: version.patch_version_id,
          revision_id: version.revision_id,
          dependency_patch_version_ids: [...version.dependency_patch_version_ids],
          target_provenance: version.target_provenance,
          proposal_payload_ids: [...version.proposal_payload_ids],
          decision: semanticRegister(version.decision)
        }))
      })),
      references: document.references.map((reference) => ({
        target_document_id: reference.target_document_id,
        state: reference.state
      }))
    }));
  }
  for (const batch of projection.review_batches) {
    entries.push(semanticEntry("review_batch", batch.review_batch_id, {
      review_batch_id: batch.review_batch_id,
      lifecycle: semanticRegister(batch.lifecycle),
      response_evidence_commitment: semanticRegister(
        batch.response_evidence_commitment
      ),
      response_import_id: semanticRegister(batch.response_import_id),
      contribution_payload_ids: [...batch.contribution_payload_ids]
    }));
  }
  for (const session of projection.rewrite_sessions) {
    entries.push(semanticEntry("rewrite_session", session.rewrite_session_id, {
      rewrite_session_id: session.rewrite_session_id,
      document_id: session.document_id,
      outcome: semanticRegister(session.outcome),
      applied_revision_ids: [...session.applied_revision_ids]
    }));
  }
  const merkle = await calculateMerkleMap("semantic_state", entries);
  return typedRoot("semantic-state-root", merkle);
}

export async function deriveRevisionHeadsRoot(
  projectionValue: CollaborationProjection,
  boundary: RevisionReadBoundary
): Promise<TypedMerkleRoot<RevisionHeadsRootId>> {
  const projection = parseCollaborationProjection(projectionValue);
  if (projection.project_id !== boundary.project_id) {
    throw new Error("Revision-head root boundary belongs to another project.");
  }
  const headsByDocument = new Map(
    projection.revision_heads.map((entry) => [entry.document_id, entry.head_revision_ids])
  );
  const entries = projection.documents
    .filter((document) => document.tombstone === null)
    .map((document) => {
      const heads = headsByDocument.get(document.document_id) ?? [];
      assertSortedUnique(heads, "live revision heads");
      return {
        key: canonicalText(document.document_id),
        value: canonicalArray(heads.map((revisionId) => canonicalText(revisionId)))
      };
    });
  for (const document of projection.documents.filter((entry) => entry.tombstone === null)) {
    const revisionIds = headsByDocument.get(document.document_id) ?? [];
    if (revisionIds.length > 0) {
      await loadVerifiedRevisionGraph(boundary, revisionIds, document.document_id);
    }
  }
  const merkle = await calculateMerkleMap("revision_heads", entries);
  return typedRoot("revision-heads-root", merkle);
}

export async function deriveConflictSetRoot(
  value: CollaborationProjection
): Promise<TypedMerkleRoot<ConflictSetRootId>> {
  const projection = parseCollaborationProjection(value);
  const entries = await Promise.all(projection.conflicts.map(async (record) => {
    const identity = await deriveDerivedConflictIdentity(record.core);
    if (identity.id !== record.conflict_id) {
      throw new Error("Derived conflict record does not match its exact conflict core.");
    }
    return {
      key: canonicalText(record.conflict_id),
      value: canonicalProtocolValue(record.core)
    };
  }));
  const merkle = await calculateMerkleMap("conflict_set", entries);
  return typedRoot("conflict-set-root", merkle);
}

export type KeyEpochPublicCommitment = Readonly<{
  schema_version: 1;
  object_kind: "key_epoch_public_commitment";
  project_id: ProjectId;
  key_epoch_id: KeyEpochId;
  commitment_algorithm: "sha256-public-commitment-v1";
  public_commitment_bytes: Uint8Array;
}>;

export async function deriveKeyEpochCommitment(
  value: KeyEpochPublicCommitment
): Promise<Readonly<{ id: KeyEpochCommitmentId; digest: Sha256Digest }>> {
  const projectId = parseEntityId("project", value.project_id);
  const epochId = parseEntityId("key-epoch", value.key_epoch_id);
  expectLiteral(value.schema_version, 1, "key-epoch commitment schema version");
  expectLiteral(value.object_kind, "key_epoch_public_commitment", "key-epoch commitment kind");
  expectLiteral(
    value.commitment_algorithm,
    "sha256-public-commitment-v1",
    "key-epoch commitment algorithm"
  );
  if (!(value.public_commitment_bytes instanceof Uint8Array)) {
    throw new Error("Key-epoch public commitment must be exact bytes.");
  }
  const digest = await sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(collaborationHashDomains.keyEpochCommitment),
    canonicalMap([
      ["schema_version", canonicalUint(BigInt(1))],
      ["object_kind", canonicalText("key_epoch_public_commitment")],
      ["project_id", canonicalText(projectId)],
      ["key_epoch_id", canonicalText(epochId)],
      ["commitment_algorithm", canonicalText("sha256-public-commitment-v1")],
      ["public_commitment_bytes", canonicalBytes(Uint8Array.from(value.public_commitment_bytes))]
    ])
  ])));
  return Object.freeze({
    id: formatDigestId("key-epoch-commitment", digest),
    digest: Uint8Array.from(digest) as Sha256Digest
  });
}

export type ControlStateCommitment = Readonly<{
  schema_version: 1;
  object_kind: "control_state_commitment";
  project_id: ProjectId;
  owner_person_id: PersonId;
  active_control_device_id: DeviceId;
  offline_root_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  merge_policy: "manual" | "auto_safe";
  root_sequence: UInt64;
  recovery_last_uncontested_control_id: ControlEventId | null;
  device_authorities: readonly DeviceAuthorityFact[];
}>;

export async function deriveControlStateRoot(
  value: ControlStateCommitment
): Promise<Readonly<{ id: ControlStateRootId; digest: Sha256Digest }>> {
  const parsed = parseControlStateCommitment(value);
  const digest = await sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(collaborationHashDomains.controlStateRoot),
    canonicalProtocolValue(parsed)
  ])));
  return Object.freeze({
    id: formatDigestId("control-state-root", digest),
    digest: Uint8Array.from(digest) as Sha256Digest
  });
}

export async function deriveResolutionOperationsHash(
  operations: readonly CheckpointResolutionOperation[]
): Promise<Sha256Digest> {
  assertResolutionOperations(operations);
  return sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(collaborationHashDomains.resolutionOperations),
    canonicalProtocolValue(operations)
  ])));
}

export type CompositeProjectionRootInput = Readonly<{
  project_id: ProjectId;
  reducer_id: typeof INITIAL_REDUCER_VERSION;
  control_head_id: ControlEventId;
  base_frontier_root: FrontierRootId;
  accepted_history_root: AcceptedHistoryRootId;
  result_semantic_state_root: SemanticStateRootId;
  result_revision_heads_root: RevisionHeadsRootId;
  result_conflict_set_root: ConflictSetRootId;
  resolution_operations_hash: Sha256Digest;
}>;

export async function deriveCompositeProjectionRoot(
  value: CompositeProjectionRootInput
): Promise<Readonly<{ id: ProjectionRootId; digest: Sha256Digest }>> {
  const projectId = parseEntityId("project", value.project_id);
  if (value.reducer_id !== INITIAL_REDUCER_VERSION) {
    throw new Error("Unknown projection reducer ID.");
  }
  const controlHead = parseDigestId("control-event", value.control_head_id);
  const digest = await sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(collaborationHashDomains.projectionRoot),
    canonicalText(projectId),
    canonicalText(value.reducer_id),
    canonicalText(controlHead),
    canonicalBytes(digestBytesFromId("frontier-root", value.base_frontier_root)),
    canonicalBytes(digestBytesFromId("accepted-history-root", value.accepted_history_root)),
    canonicalBytes(digestBytesFromId("semantic-state-root", value.result_semantic_state_root)),
    canonicalBytes(digestBytesFromId("revision-heads-root", value.result_revision_heads_root)),
    canonicalBytes(digestBytesFromId("conflict-set-root", value.result_conflict_set_root)),
    canonicalBytes(parseSha256Digest(value.resolution_operations_hash))
  ])));
  return Object.freeze({
    id: formatDigestId("projection-root", digest),
    digest: Uint8Array.from(digest) as Sha256Digest
  });
}

function semanticEntry(kind: string, id: string, value: unknown): {
  key: CanonicalValue;
  value: CanonicalValue;
} {
  return {
    key: canonicalArray([canonicalText(kind), canonicalText(id)]),
    value: canonicalProtocolValue(value)
  };
}

function semanticRegister(register: ProjectedValueRegister): unknown {
  return {
    register_version: register.register_version,
    state: register.state,
    resolved_value: register.resolved_value,
    last_uncontested_value: register.last_uncontested_value,
    contender_values: register.contenders
      .map((contender) => contender.value)
      .sort(compareStrings)
  };
}

function semanticTombstone(tombstone: ProjectedTombstone | null): unknown {
  return tombstone === null
    ? null
    : { tombstone_version: tombstone.tombstone_version, state: "permanently_deleted" };
}

function typedRoot<TId extends string>(
  kind:
    | "frontier-root"
    | "accepted-history-root"
    | "semantic-state-root"
    | "revision-heads-root"
    | "conflict-set-root",
  merkle: PatchmarkMerkleRoot
): TypedMerkleRoot<TId> {
  return Object.freeze({
    id: formatDigestId(kind, merkle.raw_digest) as unknown as TId,
    merkle
  });
}

function sortedUniqueParsed<TKind extends "semantic-event">(
  values: readonly string[],
  kind: TKind,
  label: string
): ReturnType<typeof parseDigestId<TKind>>[] {
  const parsed = values.map((value) => parseDigestId(kind, value));
  assertSortedUnique(parsed, label);
  return parsed;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      throw new Error(`${label} must be sorted and unique.`);
    }
  }
}

function parseControlStateCommitment(value: ControlStateCommitment): unknown {
  const devices = [...value.device_authorities]
    .map((fact) => ({
      device_id: parseEntityId("device", fact.device_id),
      person_id: parseEntityId("person", fact.person_id),
      signing_key_id: parseEntityId("public-key", fact.signing_key_id),
      role: expectEnum(fact.role, ["owner", "editor", "reviewer"] as const, "authority role") as CollaborationRole,
      capabilities: sortedCapabilities(fact.capabilities),
      status: expectEnum(fact.status, ["active", "revoked"] as const, "device status"),
      maximum_accepted_semantic_sequence: fact.maximum_accepted_semantic_sequence === null
        ? null
        : expectUInt64(fact.maximum_accepted_semantic_sequence, "revocation cutoff")
    }))
    .sort((left, right) => compareStrings(left.device_id, right.device_id));
  assertSortedUnique(devices.map((entry) => entry.device_id), "control devices");
  return {
    schema_version: 1,
    object_kind: "control_state_commitment",
    project_id: parseEntityId("project", value.project_id),
    owner_person_id: parseEntityId("person", value.owner_person_id),
    active_control_device_id: parseEntityId("device", value.active_control_device_id),
    offline_root_key_id: parseEntityId("public-key", value.offline_root_key_id),
    key_epoch_id: parseEntityId("key-epoch", value.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", value.key_epoch_commitment),
    merge_policy: expectEnum(value.merge_policy, ["manual", "auto_safe"] as const, "merge policy"),
    root_sequence: expectUInt64(value.root_sequence, "root sequence"),
    recovery_last_uncontested_control_id: value.recovery_last_uncontested_control_id === null
      ? null
      : parseDigestId("control-event", value.recovery_last_uncontested_control_id),
    device_authorities: devices
  };
}

function sortedCapabilities(values: readonly CollaborationCapability[]): CollaborationCapability[] {
  const output = [...values].sort(compareStrings);
  if (new Set(output).size !== output.length) {
    throw new Error("Control-state capabilities must be unique.");
  }
  return output;
}

function assertResolutionOperations(
  operations: readonly CheckpointResolutionOperation[]
): void {
  const sorted = [...operations].sort((left, right) => compareStrings(left.conflict_id, right.conflict_id));
  if (operations.some((operation, index) => operation !== sorted[index])) {
    throw new Error("Checkpoint resolution operations must be canonically sorted.");
  }
  assertSortedUnique(operations.map((operation) => operation.conflict_id), "checkpoint resolutions");
  for (const operation of operations) {
    assertSortedUnique(operation.observed_contender_event_ids, "observed conflict contenders");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

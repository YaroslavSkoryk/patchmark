import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue
} from "./canonical-cbor.ts";
import {
  canonicalProtocolValue,
  protocolValueFromCanonical
} from "./canonical-protocol.ts";
import {
  parseAttestationRecord,
  parseProjectionSnapshotRecord,
  type AttestationRecord,
  type BoundaryRevisionEntry,
  type ConsolidationCheckpointPayload,
  type ProjectionSnapshotRecord
} from "./checkpoints.ts";
import type {
  CheckpointId,
  ConflictSetRootId,
  ControlEventId,
  ProjectionRootId,
  RevisionHeadsRootId,
  SemanticStateRootId,
  StateBlobId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import {
  deriveAttestationIdentity,
  deriveProjectionSnapshotIdentity
} from "./preimages.ts";
import {
  findCommonVerifiedAncestor,
  findVerifiedRevision,
  isRevisionAncestor,
  loadVerifiedRevisionGraph,
  type RevisionReadBoundary,
  type VerifiedRevisionGraph
} from "./projection-revisions.ts";
import {
  deriveConflictSetRoot,
  deriveRevisionHeadsRoot,
  deriveSemanticStateRoot
} from "./projection-roots.ts";
import {
  parseCollaborationProjection,
  type CollaborationProjection
} from "./projection-types.ts";
import { collaborationHashDomains } from "./domains.ts";
import { formatDigestId } from "./digest-ids.ts";
import { sha256, type Sha256Digest } from "./sha256.ts";
import {
  expectExactRecord,
  expectLiteral,
  freezeRecord
} from "./validation.ts";
import {
  INITIAL_REDUCER_VERSION,
  SNAPSHOT_RECORD_VERSION,
  STATE_BLOB_RECORD_VERSION,
  STATE_BLOB_SCHEMA_VERSION
} from "./versions.ts";
import type {
  FullHistoryCheckpointVerificationResult,
  PreparedConsolidationCheckpoint
} from "./checkpoint-verification.ts";

export type CanonicalStateBlobCore = Readonly<{
  schema_version: typeof STATE_BLOB_SCHEMA_VERSION;
  object_kind: "canonical_state_blob_core";
  project_id: import("./identities.ts").ProjectId;
  reducer_version: typeof INITIAL_REDUCER_VERSION;
  checkpoint_id: CheckpointId;
  control_head_id: ControlEventId;
  semantic_state_root: SemanticStateRootId;
  revision_heads_root: RevisionHeadsRootId;
  conflict_set_root: ConflictSetRootId;
  projection_root: ProjectionRootId;
  projection: CollaborationProjection;
}>;

export type CanonicalStateBlobRecord = Readonly<{
  record_version: typeof STATE_BLOB_RECORD_VERSION;
  object_kind: "canonical_state_blob";
  state_blob_id: StateBlobId;
  core: CanonicalStateBlobCore;
}>;

export type VerifiedStateBlob = Readonly<{
  status: "verified";
  record: CanonicalStateBlobRecord;
  canonical_core_bytes: Uint8Array;
}>;

export type SnapshotVerificationResult =
  | Readonly<{
      status: "verified";
      snapshot: ProjectionSnapshotRecord;
      state_blob: VerifiedStateBlob;
    }>
  | Readonly<{
      status: "invalid" | "incomplete_dependencies";
      reason: string;
    }>;

export type SnapshotVerificationInput = RevisionReadBoundary & Readonly<{
  checkpoint_id: CheckpointId;
  checkpoint_payload: ConsolidationCheckpointPayload;
  snapshot: ProjectionSnapshotRecord;
  state_blob: CanonicalStateBlobRecord;
  read_attestation?: (
    attestationId: import("./identities.ts").AttestationId
  ) => Promise<import("./storage.ts").CollaborationReadResult<AttestationRecord>>;
}>;

export function parseCanonicalStateBlobCore(value: unknown): CanonicalStateBlobCore {
  const record = expectExactRecord(value, "canonical state blob core", [
    "schema_version",
    "object_kind",
    "project_id",
    "reducer_version",
    "checkpoint_id",
    "control_head_id",
    "semantic_state_root",
    "revision_heads_root",
    "conflict_set_root",
    "projection_root",
    "projection"
  ]);
  expectLiteral(record.schema_version, STATE_BLOB_SCHEMA_VERSION, "state blob schema version");
  expectLiteral(record.object_kind, "canonical_state_blob_core", "state blob kind");
  expectLiteral(record.reducer_version, INITIAL_REDUCER_VERSION, "state blob reducer");
  const projectId = parseEntityId("project", record.project_id);
  const projection = parseCollaborationProjection(record.projection);
  if (projection.project_id !== projectId || projection.reducer_version !== INITIAL_REDUCER_VERSION) {
    throw new Error("State blob projection ownership or reducer does not match its core.");
  }
  return freezeRecord({
    schema_version: STATE_BLOB_SCHEMA_VERSION,
    object_kind: "canonical_state_blob_core" as const,
    project_id: projectId,
    reducer_version: INITIAL_REDUCER_VERSION,
    checkpoint_id: parseDigestId("semantic-event", record.checkpoint_id) as CheckpointId,
    control_head_id: parseDigestId("control-event", record.control_head_id),
    semantic_state_root: parseDigestId("semantic-state-root", record.semantic_state_root),
    revision_heads_root: parseDigestId("revision-heads-root", record.revision_heads_root),
    conflict_set_root: parseDigestId("conflict-set-root", record.conflict_set_root),
    projection_root: parseDigestId("projection-root", record.projection_root),
    projection
  });
}

export function parseCanonicalStateBlobRecord(value: unknown): CanonicalStateBlobRecord {
  const record = expectExactRecord(value, "canonical state blob record", [
    "record_version",
    "object_kind",
    "state_blob_id",
    "core"
  ]);
  expectLiteral(record.record_version, STATE_BLOB_RECORD_VERSION, "state blob record version");
  expectLiteral(record.object_kind, "canonical_state_blob", "state blob record kind");
  return freezeRecord({
    record_version: STATE_BLOB_RECORD_VERSION,
    object_kind: "canonical_state_blob" as const,
    state_blob_id: parseDigestId("state-blob", record.state_blob_id),
    core: parseCanonicalStateBlobCore(record.core)
  });
}

export function encodeCanonicalStateBlobCore(core: CanonicalStateBlobCore): Uint8Array {
  const parsed = parseCanonicalStateBlobCore(core);
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(collaborationHashDomains.stateBlob),
    canonicalProtocolValue(parsed)
  ]));
}

export function decodeCanonicalStateBlobCore(bytes: Uint8Array): CanonicalStateBlobCore {
  const decoded = inspectCanonicalValue(decodeCanonicalCbor(Uint8Array.from(bytes)));
  if (decoded.kind !== "array" || decoded.values.length !== 2) {
    throw new Error("State blob must be one domain-separated canonical array.");
  }
  const domain = inspectCanonicalValue(decoded.values[0]);
  if (domain.kind !== "text" || domain.value !== collaborationHashDomains.stateBlob) {
    throw new Error("State blob uses the wrong hash domain.");
  }
  return parseCanonicalStateBlobCore(protocolValueFromCanonical(decoded.values[1]));
}

export async function deriveCanonicalStateBlobIdentity(
  core: CanonicalStateBlobCore
): Promise<Readonly<{
  id: StateBlobId;
  digest: Sha256Digest;
  canonical_bytes: Uint8Array;
}>> {
  const bytes = encodeCanonicalStateBlobCore(core);
  const digest = await sha256(bytes);
  return Object.freeze({
    id: formatDigestId("state-blob", digest),
    digest: Uint8Array.from(digest) as Sha256Digest,
    canonical_bytes: Uint8Array.from(bytes)
  });
}

export async function constructStateBlob(
  verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>
): Promise<CanonicalStateBlobRecord> {
  return stateBlobFromPrepared(
    verification.checkpoint_id,
    verification.prepared
  );
}

export async function stateBlobFromPrepared(
  checkpointId: CheckpointId,
  prepared: PreparedConsolidationCheckpoint
): Promise<CanonicalStateBlobRecord> {
  const core = parseCanonicalStateBlobCore({
    schema_version: STATE_BLOB_SCHEMA_VERSION,
    object_kind: "canonical_state_blob_core",
    project_id: prepared.payload.project_id,
    reducer_version: INITIAL_REDUCER_VERSION,
    checkpoint_id: checkpointId,
    control_head_id: prepared.payload.data.authorizing_control_head_id,
    semantic_state_root: prepared.payload.data.result_semantic_state_root,
    revision_heads_root: prepared.payload.data.result_revision_heads_root,
    conflict_set_root: prepared.payload.data.result_conflict_set_root,
    projection_root: prepared.payload.data.projection_root,
    projection: prepared.result_projection
  });
  const identity = await deriveCanonicalStateBlobIdentity(core);
  return parseCanonicalStateBlobRecord({
    record_version: STATE_BLOB_RECORD_VERSION,
    object_kind: "canonical_state_blob",
    state_blob_id: identity.id,
    core
  });
}

export async function verifyStateBlob(
  recordValue: CanonicalStateBlobRecord,
  checkpointId: CheckpointId,
  payload: ConsolidationCheckpointPayload,
  boundary: RevisionReadBoundary
): Promise<VerifiedStateBlob> {
  const record = parseCanonicalStateBlobRecord(recordValue);
  if (
    record.core.checkpoint_id !== checkpointId ||
    record.core.project_id !== payload.project_id ||
    record.core.control_head_id !== payload.data.authorizing_control_head_id ||
    record.core.projection_root !== payload.data.projection_root
  ) {
    throw new Error("State blob does not bind the exact verified checkpoint.");
  }
  const identity = await deriveCanonicalStateBlobIdentity(record.core);
  if (identity.id !== record.state_blob_id) {
    throw new Error("State blob ID does not match its canonical core.");
  }
  const semantic = await deriveSemanticStateRoot(record.core.projection);
  const revisions = await deriveRevisionHeadsRoot(record.core.projection, boundary);
  const conflicts = await deriveConflictSetRoot(record.core.projection);
  if (
    semantic.id !== record.core.semantic_state_root ||
    revisions.id !== record.core.revision_heads_root ||
    conflicts.id !== record.core.conflict_set_root ||
    semantic.id !== payload.data.result_semantic_state_root ||
    revisions.id !== payload.data.result_revision_heads_root ||
    conflicts.id !== payload.data.result_conflict_set_root
  ) {
    throw new Error("State blob component roots do not match the checkpoint result.");
  }
  return Object.freeze({
    status: "verified" as const,
    record,
    canonical_core_bytes: identity.canonical_bytes
  });
}

export async function constructProjectionSnapshot(
  verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>,
  stateBlob: CanonicalStateBlobRecord,
  boundary: RevisionReadBoundary,
  producerAttestationId: import("./identities.ts").AttestationId | null = null
): Promise<ProjectionSnapshotRecord> {
  const verifiedBlob = await verifyStateBlob(
    stateBlob,
    verification.checkpoint_id,
    verification.prepared.payload,
    boundary
  );
  const manifest = await deriveRequiredBoundaryManifest(
    verifiedBlob.record.core.projection,
    boundary
  );
  const core = {
    schema_version: 1 as const,
    object_kind: "projection_snapshot_core" as const,
    project_id: verifiedBlob.record.core.project_id,
    checkpoint_id: verification.checkpoint_id,
    reducer_version: INITIAL_REDUCER_VERSION,
    state_blob_id: verifiedBlob.record.state_blob_id,
    semantic_state_root: verifiedBlob.record.core.semantic_state_root,
    revision_heads_root: verifiedBlob.record.core.revision_heads_root,
    conflict_set_root: verifiedBlob.record.core.conflict_set_root,
    projection_root: verifiedBlob.record.core.projection_root,
    boundary_revisions: manifest,
    live_conflict_dependencies: verifiedBlob.record.core.projection.conflicts.map(
      (conflict) => conflict.conflict_id
    )
  };
  const identity = await deriveProjectionSnapshotIdentity(core);
  return parseProjectionSnapshotRecord({
    record_version: SNAPSHOT_RECORD_VERSION,
    object_kind: "projection_snapshot",
    snapshot_id: identity.id,
    core,
    producer_attestation_id: producerAttestationId
  }, verification.checkpoint_id);
}

export async function verifyProjectionSnapshot(
  input: SnapshotVerificationInput
): Promise<SnapshotVerificationResult> {
  try {
    const snapshot = parseProjectionSnapshotRecord(
      input.snapshot,
      input.checkpoint_id
    );
    const identity = await deriveProjectionSnapshotIdentity(snapshot.core);
    if (identity.id !== snapshot.snapshot_id) {
      throw new Error("Snapshot ID does not match its core.");
    }
    const stateBlob = await verifyStateBlob(
      input.state_blob,
      input.checkpoint_id,
      input.checkpoint_payload,
      input
    );
    if (
      snapshot.core.project_id !== input.project_id ||
      snapshot.core.state_blob_id !== stateBlob.record.state_blob_id ||
      snapshot.core.semantic_state_root !== stateBlob.record.core.semantic_state_root ||
      snapshot.core.revision_heads_root !== stateBlob.record.core.revision_heads_root ||
      snapshot.core.conflict_set_root !== stateBlob.record.core.conflict_set_root ||
      snapshot.core.projection_root !== stateBlob.record.core.projection_root
    ) {
      throw new Error("Snapshot roots or state blob do not match the verified checkpoint.");
    }
    await verifyBoundaryManifest(
      snapshot.core.boundary_revisions,
      stateBlob.record.core.projection,
      input
    );
    const expectedConflicts = stateBlob.record.core.projection.conflicts.map(
      (conflict) => conflict.conflict_id
    );
    if (!sameStrings(snapshot.core.live_conflict_dependencies, expectedConflicts)) {
      throw new Error("Snapshot live conflict dependency manifest does not match the projection.");
    }
    if (snapshot.producer_attestation_id !== null) {
      if (!input.read_attestation) throw new Error("Snapshot producer attestation reader is unavailable.");
      const result = await input.read_attestation(snapshot.producer_attestation_id);
      if (result.status !== "valid") {
        throw new Error(`Snapshot producer attestation is ${result.status}: ${result.reason}`);
      }
      const attestation = parseAttestationRecord(result.value);
      const attestationIdentity = await deriveAttestationIdentity(attestation.core);
      if (
        attestationIdentity.id !== snapshot.producer_attestation_id ||
        attestation.core.project_id !== input.project_id ||
        attestation.core.subject_kind !== "snapshot" ||
        attestation.core.subject_id !== snapshot.snapshot_id
      ) {
        throw new Error("Snapshot producer attestation is not bound to the snapshot.");
      }
    }
    return Object.freeze({ status: "verified" as const, snapshot, state_blob: stateBlob });
  } catch (error) {
    const reason = errorMessage(error);
    return Object.freeze({
      status: isUnavailableDependencyReason(reason)
        ? "incomplete_dependencies" as const
        : "invalid" as const,
      reason
    });
  }
}

export async function deriveRequiredBoundaryManifest(
  projectionValue: CollaborationProjection,
  boundary: RevisionReadBoundary
): Promise<readonly BoundaryRevisionEntry[]> {
  const projection = parseCollaborationProjection(projectionValue);
  const required = new Map<string, { document_id: import("./identities.ts").DocumentId; revision_id: import("./identities.ts").DocumentRevisionId }>();
  const add = (documentId: import("./identities.ts").DocumentId, revisionId: import("./identities.ts").DocumentRevisionId) => {
    required.set(`${documentId}\u0000${revisionId}`, { document_id: documentId, revision_id: revisionId });
  };
  for (const heads of projection.revision_heads) {
    for (const revisionId of heads.head_revision_ids) add(heads.document_id, revisionId);
    if (heads.head_revision_ids.length > 1) {
      const graph = await loadVerifiedRevisionGraph(boundary, heads.head_revision_ids, heads.document_id);
      for (const base of maximalCommonAncestors(graph, heads.head_revision_ids)) {
        add(heads.document_id, base);
      }
    }
  }
  for (const document of projection.documents) {
    for (const patch of document.patches) {
      for (const version of patch.versions) {
        if (version.revision_id !== null) add(document.document_id, version.revision_id);
      }
    }
  }
  for (const session of projection.rewrite_sessions) {
    for (const revisionId of session.applied_revision_ids) add(session.document_id, revisionId);
  }
  for (const conflict of projection.conflicts) {
    if (conflict.core.conflict_kind === "content") {
      for (const revisionId of conflict.core.contender_revision_ids) {
        add(conflict.core.document_id, revisionId);
      }
      if (conflict.core.base_revision_id !== null) {
        add(conflict.core.document_id, conflict.core.base_revision_id);
      }
    }
  }
  const output: BoundaryRevisionEntry[] = [];
  for (const dependency of [...required.values()].sort(byBoundaryEntry)) {
    const graph = await loadVerifiedRevisionGraph(
      boundary,
      [dependency.revision_id],
      dependency.document_id
    );
    const revision = findVerifiedRevision(graph, dependency.revision_id);
    if (!revision) throw new Error("Boundary manifest revision could not be verified.");
    output.push(Object.freeze({
      document_id: dependency.document_id,
      revision_id: dependency.revision_id,
      traversal: revision.record.core.ancestry_kind === "admission_boundary"
        ? "boundary_root" as const
        : "complete" as const
    }));
  }
  return Object.freeze(output);
}

async function verifyBoundaryManifest(
  manifest: readonly BoundaryRevisionEntry[],
  projection: CollaborationProjection,
  boundary: RevisionReadBoundary
): Promise<void> {
  const required = await deriveRequiredBoundaryManifest(projection, boundary);
  const actualKeys = new Set(manifest.map(boundaryKey));
  for (const entry of required) {
    if (!actualKeys.has(boundaryKey(entry))) {
      throw new Error(`Snapshot is missing required boundary revision ${entry.revision_id}.`);
    }
  }
  for (const entry of manifest) {
    const graph = await loadVerifiedRevisionGraph(boundary, [entry.revision_id], entry.document_id);
    const revision = findVerifiedRevision(graph, entry.revision_id);
    if (!revision) throw new Error("Snapshot boundary revision is unavailable.");
    const expectedTraversal = revision.record.core.ancestry_kind === "admission_boundary"
      ? "boundary_root"
      : "complete";
    if (entry.traversal !== expectedTraversal) {
      throw new Error("Snapshot boundary traversal marker does not match the revision core.");
    }
  }
}

function maximalCommonAncestors(
  graph: VerifiedRevisionGraph,
  heads: readonly import("./identities.ts").DocumentRevisionId[]
): readonly import("./identities.ts").DocumentRevisionId[] {
  const common = findCommonVerifiedAncestor(graph, heads);
  return common.filter((candidate) =>
    !common.some((other) => candidate !== other && isRevisionAncestor(graph, candidate, other))
  );
}

function boundaryKey(entry: BoundaryRevisionEntry): string {
  return `${entry.document_id}\u0000${entry.revision_id}`;
}

function byBoundaryEntry(left: { document_id: string; revision_id: string }, right: { document_id: string; revision_id: string }): number {
  return left.document_id < right.document_id
    ? -1
    : left.document_id > right.document_id
      ? 1
      : left.revision_id < right.revision_id
        ? -1
        : left.revision_id > right.revision_id
          ? 1
          : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailableDependencyReason(reason: string): boolean {
  return /\b(?:is|are) (?:missing|incomplete|unavailable)(?::|\.|$)/i.test(reason) ||
    /reader is unavailable/i.test(reason);
}

import {
  INITIAL_REDUCER_VERSION,
  buildSignaturePreimage,
  bytesToHex,
  calculateMerkleMap,
  calculateMerkleSet,
  canonicalArray,
  canonicalBytes,
  canonicalMap,
  canonicalProtocolValue,
  canonicalText,
  deriveAcceptedHistoryRoot,
  deriveAcknowledgementIdentity,
  deriveBaseFrontierRoot,
  deriveCanonicalStateBlobIdentity,
  deriveCompositeProjectionRoot,
  deriveConflictSetRoot,
  deriveControlStateRoot,
  deriveKeyEpochCommitment,
  deriveProjectionSnapshotIdentity,
  deriveResolutionOperationsHash,
  deriveRevisionHeadsRoot,
  deriveSemanticStateRoot,
  digestBytesFromId,
  encodeCanonicalCbor,
  formatDigestId,
  hexToBytes,
  parseAcknowledgementCore,
  parseCanonicalStateBlobCore,
  parseCollaborationProjection,
  parseProjectionSnapshotCore,
  type CheckpointResolutionOperation,
  type LoadedProjectionHistory,
  type MerkleTreeFamily
} from "../lib/collaboration/index.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type CollaborationRootVectorFile = Readonly<{
  profile: "patchmark-collaboration-roots-v1";
  ids: Readonly<Record<string, string>>;
  merkle_vectors: readonly Readonly<{
    name: string;
    family: MerkleTreeFamily;
    kind: "set" | "map";
    entries: readonly Readonly<{ key: JsonValue; value?: JsonValue }>[];
    root_id_kind?: "frontier-root" | "accepted-history-root" | "semantic-state-root" | "revision-heads-root" | "conflict-set-root";
  }>[];
  duplicate_key_case: Readonly<{
    family: MerkleTreeFamily;
    kind: "set" | "map";
    entries: readonly Readonly<{ key: JsonValue; value?: JsonValue }>[];
  }>;
  component_inputs: Readonly<{
    base_frontier_event_ids: readonly string[];
    accepted_events: readonly Readonly<{ event_id: string; author_attestation_id: string }>[];
    projection: JsonValue;
  }>;
  resolution_operations: readonly JsonValue[];
  key_epoch: Readonly<{ public_commitment_hex: string }>;
  control_state: JsonValue;
  snapshot: Readonly<{ boundary_revisions: readonly JsonValue[]; live_conflict_dependencies: readonly string[] }>;
  acknowledgement: JsonValue;
  verification_cases: Readonly<{
    complete_checkpoint_status: "full_history_verified";
    onboarding_boundary_status: "owner_authorized_boundary_verified";
    onboarding_full_history_verified: false;
  }>;
  expected: JsonValue;
}>;

export async function deriveCollaborationRootVectorActual(
  vectors: CollaborationRootVectorFile
): Promise<JsonValue> {
  if (vectors.profile !== "patchmark-collaboration-roots-v1") {
    throw new Error("Unknown collaboration root vector profile.");
  }
  const merkleResults: Record<string, JsonValue> = {};
  for (const vector of vectors.merkle_vectors) {
    const entries = vector.entries.map((entry) => ({
      key: canonicalProtocolValue(entry.key),
      ...(vector.kind === "map" ? { value: canonicalProtocolValue(requiredValue(entry)) } : {})
    }));
    const result = vector.kind === "set"
      ? await calculateMerkleSet(vector.family, entries)
      : await calculateMerkleMap(vector.family, entries as Array<{
          key: ReturnType<typeof canonicalProtocolValue>;
          value: ReturnType<typeof canonicalProtocolValue>;
        }>);
    merkleResults[vector.name] = {
      entry_count: result.entry_count,
      root_hex: bytesToHex(result.raw_digest),
      ...(vector.root_id_kind === undefined
        ? {}
        : { root_id: formatRootId(vector.root_id_kind, result.raw_digest) })
    };
  }

  let duplicateKeyRejected = false;
  try {
    const entries = vectors.duplicate_key_case.entries.map((entry) => ({
      key: canonicalProtocolValue(entry.key),
      ...(vectors.duplicate_key_case.kind === "map"
        ? { value: canonicalProtocolValue(requiredValue(entry)) }
        : {})
    }));
    if (vectors.duplicate_key_case.kind === "set") {
      await calculateMerkleSet(vectors.duplicate_key_case.family, entries);
    } else {
      await calculateMerkleMap(vectors.duplicate_key_case.family, entries as Array<{
        key: ReturnType<typeof canonicalProtocolValue>;
        value: ReturnType<typeof canonicalProtocolValue>;
      }>);
    }
  } catch (error) {
    duplicateKeyRejected = /duplicate canonical keys/i.test(errorMessage(error));
  }
  if (!duplicateKeyRejected) throw new Error("Duplicate-key vector did not reject.");

  const projectId = vectors.ids.project as never;
  const projection = parseCollaborationProjection(vectors.component_inputs.projection);
  const baseFrontier = await deriveBaseFrontierRoot(
    vectors.component_inputs.base_frontier_event_ids as never
  );
  const acceptedHistory = await deriveAcceptedHistoryRoot({
    events: vectors.component_inputs.accepted_events.map((entry) => ({
      event: {
        event_id: entry.event_id,
        author_attestation_ids: [entry.author_attestation_id]
      }
    }))
  } as unknown as LoadedProjectionHistory);
  const semanticState = await deriveSemanticStateRoot(projection);
  const revisionHeads = await deriveRevisionHeadsRoot(projection, {
    project_id: projectId,
    read_revision: async () => ({ status: "missing", reason: "root vector has no revisions" }),
    read_blob: async () => ({ status: "missing", reason: "root vector has no blobs" })
  });
  const conflictSet = await deriveConflictSetRoot(projection);
  const resolutionOperations = vectors.resolution_operations as unknown as readonly CheckpointResolutionOperation[];
  const resolutionHash = await deriveResolutionOperationsHash(resolutionOperations);

  const epochInput = {
    schema_version: 1 as const,
    object_kind: "key_epoch_public_commitment" as const,
    project_id: projectId,
    key_epoch_id: vectors.ids.key_epoch as never,
    commitment_algorithm: "sha256-public-commitment-v1" as const,
    public_commitment_bytes: hexToBytes(vectors.key_epoch.public_commitment_hex)
  };
  const epoch = await deriveKeyEpochCommitment(epochInput);
  const epochBytes = encodeCanonicalCbor(canonicalArray([
    canonicalText("patchmark/key-epoch-commitment/v1"),
    canonicalMap([
      ["schema_version", canonicalProtocolValue(1)],
      ["object_kind", canonicalText("key_epoch_public_commitment")],
      ["project_id", canonicalText(projectId)],
      ["key_epoch_id", canonicalText(vectors.ids.key_epoch)],
      ["commitment_algorithm", canonicalText("sha256-public-commitment-v1")],
      ["public_commitment_bytes", canonicalBytes(hexToBytes(vectors.key_epoch.public_commitment_hex))]
    ])
  ]));

  const controlInput = withBigInts({
    ...(vectors.control_state as Readonly<Record<string, JsonValue>>),
    project_id: vectors.ids.project,
    key_epoch_id: vectors.ids.key_epoch,
    key_epoch_commitment: epoch.id
  }, ["root_sequence", "maximum_accepted_semantic_sequence"]);
  const control = await deriveControlStateRoot(controlInput as never);

  const composite = await deriveCompositeProjectionRoot({
    project_id: projectId,
    reducer_id: INITIAL_REDUCER_VERSION,
    control_head_id: vectors.ids.control_head as never,
    base_frontier_root: baseFrontier.id,
    accepted_history_root: acceptedHistory.id,
    result_semantic_state_root: semanticState.id,
    result_revision_heads_root: revisionHeads.id,
    result_conflict_set_root: conflictSet.id,
    resolution_operations_hash: resolutionHash as never
  });
  const compositeBytes = encodeCanonicalCbor(canonicalArray([
    canonicalText("patchmark/projection-root/v1"),
    canonicalText(vectors.ids.project),
    canonicalText(INITIAL_REDUCER_VERSION),
    canonicalText(vectors.ids.control_head),
    canonicalBytes(digestBytesFromId("frontier-root", baseFrontier.id)),
    canonicalBytes(digestBytesFromId("accepted-history-root", acceptedHistory.id)),
    canonicalBytes(digestBytesFromId("semantic-state-root", semanticState.id)),
    canonicalBytes(digestBytesFromId("revision-heads-root", revisionHeads.id)),
    canonicalBytes(digestBytesFromId("conflict-set-root", conflictSet.id)),
    canonicalBytes(resolutionHash)
  ]));

  const stateCore = parseCanonicalStateBlobCore({
    schema_version: 1,
    object_kind: "canonical_state_blob_core",
    project_id: vectors.ids.project,
    reducer_version: INITIAL_REDUCER_VERSION,
    checkpoint_id: vectors.ids.checkpoint,
    control_head_id: vectors.ids.control_head,
    semantic_state_root: semanticState.id,
    revision_heads_root: revisionHeads.id,
    conflict_set_root: conflictSet.id,
    projection_root: composite.id,
    projection
  });
  const stateBlob = await deriveCanonicalStateBlobIdentity(stateCore);
  const snapshotCore = parseProjectionSnapshotCore({
    schema_version: 1,
    object_kind: "projection_snapshot_core",
    project_id: vectors.ids.project,
    checkpoint_id: vectors.ids.checkpoint,
    reducer_version: INITIAL_REDUCER_VERSION,
    state_blob_id: stateBlob.id,
    semantic_state_root: semanticState.id,
    revision_heads_root: revisionHeads.id,
    conflict_set_root: conflictSet.id,
    projection_root: composite.id,
    boundary_revisions: vectors.snapshot.boundary_revisions,
    live_conflict_dependencies: vectors.snapshot.live_conflict_dependencies
  }, vectors.ids.checkpoint as never);
  const snapshot = await deriveProjectionSnapshotIdentity(snapshotCore);

  const acknowledgementInput = withBigInts({
    ...(vectors.acknowledgement as Readonly<Record<string, JsonValue>>),
    project_id: vectors.ids.project,
    observed_control_head_id: vectors.ids.control_head,
    acknowledged_checkpoint_id: vectors.ids.checkpoint,
    projection_root: composite.id
  }, ["acknowledgement_sequence", "highest_contiguous_sequence"]);
  const acknowledgementCore = parseAcknowledgementCore(
    acknowledgementInput,
    vectors.ids.checkpoint as never
  );
  const acknowledgement = await deriveAcknowledgementIdentity(acknowledgementCore);
  const acknowledgementSignatureBytes = encodeCanonicalCbor(
    buildSignaturePreimage(
      "acknowledgement",
      projectId,
      acknowledgement.id
    )
  );

  assertVerificationCaseSemantics(vectors);
  return {
    merkle: merkleResults,
    rejection: { duplicate_canonical_key: true },
    component_roots: {
      base_frontier: rootResult(baseFrontier),
      accepted_history: rootResult(acceptedHistory),
      semantic_state: rootResult(semanticState),
      revision_heads: rootResult(revisionHeads),
      conflict_set: rootResult(conflictSet)
    },
    key_epoch: {
      canonical_hex: bytesToHex(epochBytes),
      ...identityResult(epoch.digest, epoch.id)
    },
    control_state: identityResult(control.digest, control.id),
    resolution_operations: {
      canonical_hex: bytesToHex(encodeCanonicalCbor(canonicalArray([
        canonicalText("patchmark/resolution-operations/v1"),
        canonicalProtocolValue(resolutionOperations)
      ]))),
      digest_hex: bytesToHex(resolutionHash)
    },
    composite_projection: {
      canonical_hex: bytesToHex(compositeBytes),
      ...identityResult(composite.digest, composite.id)
    },
    state_blob: identityResult(stateBlob.digest, stateBlob.id),
    snapshot: identityResult(snapshot.digest, snapshot.id),
    acknowledgement: {
      ...identityResult(acknowledgement.digest, acknowledgement.id),
      signature_preimage_hex: bytesToHex(acknowledgementSignatureBytes)
    },
    verification_cases: {
      complete_checkpoint: {
        status: "full_history_verified",
        checkpoint_id: vectors.ids.checkpoint,
        projection_root: composite.id
      },
      onboarding_boundary: {
        status: "owner_authorized_boundary_verified",
        checkpoint_id: vectors.ids.checkpoint,
        snapshot_id: snapshot.id,
        full_history_verified: false,
        verification_basis: "owner_authorized_current_state"
      }
    }
  };
}

export async function evaluateCollaborationRootVectors(
  vectors: CollaborationRootVectorFile
): Promise<Readonly<{
  merkle_vectors: number;
  component_roots: number;
  identity_vectors: number;
  verification_cases: number;
  duplicate_rejections: number;
}>> {
  const actual = await deriveCollaborationRootVectorActual(vectors);
  assertJsonEqual(actual, vectors.expected, "frozen collaboration root vectors");
  return Object.freeze({
    merkle_vectors: vectors.merkle_vectors.length,
    component_roots: 5,
    identity_vectors: 7,
    verification_cases: 2,
    duplicate_rejections: 1
  });
}

function rootResult(value: Readonly<{ id: string; merkle: { raw_digest: Uint8Array; entry_count: number } }>): JsonValue {
  return {
    entry_count: value.merkle.entry_count,
    root_hex: bytesToHex(value.merkle.raw_digest),
    root_id: value.id
  };
}

function identityResult(digest: Uint8Array, id: string): Readonly<Record<string, JsonValue>> {
  return {
    digest_hex: bytesToHex(digest),
    id
  };
}

function formatRootId(
  kind: "frontier-root" | "accepted-history-root" | "semantic-state-root" | "revision-heads-root" | "conflict-set-root",
  digest: Uint8Array
): string {
  switch (kind) {
    case "frontier-root": return formatDigestId("frontier-root", digest);
    case "accepted-history-root": return formatDigestId("accepted-history-root", digest);
    case "semantic-state-root": return formatDigestId("semantic-state-root", digest);
    case "revision-heads-root": return formatDigestId("revision-heads-root", digest);
    case "conflict-set-root": return formatDigestId("conflict-set-root", digest);
  }
}

function withBigInts(
  value: Readonly<Record<string, JsonValue>>,
  integerKeys: readonly string[]
): unknown {
  if (Array.isArray(value)) return value.map((entry) =>
    typeof entry === "object" && entry !== null
      ? withBigInts(entry as Readonly<Record<string, JsonValue>>, integerKeys)
      : entry
  );
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (integerKeys.includes(key) && typeof child === "number") return [key, BigInt(child)];
    if (Array.isArray(child)) {
      return [key, child.map((entry) =>
        typeof entry === "object" && entry !== null
          ? withBigInts(entry as Readonly<Record<string, JsonValue>>, integerKeys)
          : entry
      )];
    }
    if (typeof child === "object" && child !== null) {
      return [key, withBigInts(child as Readonly<Record<string, JsonValue>>, integerKeys)];
    }
    return [key, child];
  }));
}

function requiredValue(entry: Readonly<{ value?: JsonValue }>): JsonValue {
  if (entry.value === undefined) throw new Error("Merkle map vector is missing a value.");
  return entry.value;
}

function assertVerificationCaseSemantics(vectors: CollaborationRootVectorFile): void {
  if (
    vectors.verification_cases.complete_checkpoint_status !== "full_history_verified" ||
    vectors.verification_cases.onboarding_boundary_status !== "owner_authorized_boundary_verified" ||
    vectors.verification_cases.onboarding_full_history_verified !== false
  ) {
    throw new Error("Frozen verification cases misstate checkpoint or onboarding trust semantics.");
  }
}

function assertJsonEqual(actual: JsonValue, expected: JsonValue, label: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label} mismatch.\nExpected: ${right}\nActual:   ${left}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

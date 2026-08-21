import {
  buildSignaturePreimage,
  bytesToHex,
  canonicalArray,
  canonicalBoolean,
  canonicalBytes,
  canonicalMap,
  canonicalNull,
  canonicalText,
  canonicalUint,
  checkpointIdFromConsolidationEvent,
  decodeCanonicalCbor,
  decodeSha256Base32,
  deriveAcknowledgementIdentity,
  deriveAttestationIdentity,
  deriveControlActionIdentity,
  deriveControlEventIdentity,
  deriveDerivedConflictIdentity,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveMergeKeyIdentity,
  deriveProjectionSnapshotIdentity,
  deriveSemanticEventIdentity,
  deriveSemanticPayloadIdentity,
  encodeCanonicalCbor,
  encodeSha256Base32,
  hexToBytes,
  parseAcknowledgementCore,
  parseAttestationCore,
  parseControlActionCore,
  parseControlEventCore,
  parseDerivedConflictCore,
  parseDocumentRevisionCore,
  parseMergeKeyCore,
  parseProjectionSnapshotCore,
  parseSemanticEventCore,
  parseSemanticPayloadCore,
  parseSemanticPayloadRecord,
  sha256
} from "../lib/collaboration/index.ts";

export type CollaborationVectorFile = Readonly<{
  profile: string;
  cbor: Readonly<{
    accepted: readonly Readonly<{ name: string; expected_hex: string }>[];
    rejected: readonly Readonly<{ name: string; encoded_hex: string }>[];
  }>;
  sha256: readonly Readonly<{
    name: string;
    input_hex: string;
    digest_hex: string;
  }>[];
  base32: Readonly<{
    accepted: readonly Readonly<{
      name: string;
      digest_hex: string;
      encoded: string;
    }>[];
    rejected: readonly Readonly<{ name: string; encoded: string }>[];
  }>;
  objects: readonly Readonly<{
    name: ObjectFixtureName;
    logical_input: string;
    canonical_cbor_hex: string;
    sha256_hex: string;
    base32: string;
    display_id: string;
  }>[];
  signatures: readonly Readonly<{
    subject_kind: SignatureFixtureName;
    canonical_preimage_hex: string;
  }>[];
}>;

type ObjectFixtureName =
  | "acknowledgement"
  | "attestation"
  | "control_action"
  | "control_event"
  | "derived_conflict"
  | "document_revision"
  | "markdown_blob"
  | "merge_key"
  | "projection_snapshot"
  | "semantic_event"
  | "semantic_payload";

type SignatureFixtureName =
  | "acknowledgement"
  | "control_event"
  | "semantic_event"
  | "snapshot";

export async function evaluateCollaborationVectors(
  vectors: CollaborationVectorFile
): Promise<Readonly<{
  base32_vectors: number;
  cbor_vectors: number;
  object_vectors: number;
  sha256_vectors: number;
  signature_vectors: number;
}>> {
  assertEqual(vectors.profile, "patchmark-deterministic-cbor-v1", "vector profile");
  const fundamentals = canonicalFundamentals();
  for (const vector of vectors.cbor.accepted) {
    const value = fundamentals.get(vector.name);
    if (!value) throw new Error(`Missing canonical CBOR fixture ${vector.name}.`);
    assertEqual(
      bytesToHex(encodeCanonicalCbor(value)),
      vector.expected_hex,
      `CBOR encode ${vector.name}`
    );
    const bytes = hexToBytes(vector.expected_hex);
    assertEqual(
      bytesToHex(encodeCanonicalCbor(decodeCanonicalCbor(bytes))),
      vector.expected_hex,
      `CBOR decode ${vector.name}`
    );
  }
  for (const vector of vectors.cbor.rejected) {
    assertThrows(
      () => decodeCanonicalCbor(hexToBytes(vector.encoded_hex)),
      `CBOR rejection ${vector.name}`
    );
  }
  assertConstructionRejections();

  await Promise.all(
    vectors.sha256.map(async (vector) => {
      const digest = await sha256(hexToBytes(vector.input_hex));
      assertEqual(bytesToHex(digest), vector.digest_hex, `SHA-256 ${vector.name}`);
    })
  );

  for (const vector of vectors.base32.accepted) {
    const digest = hexToBytes(vector.digest_hex);
    assertEqual(encodeSha256Base32(digest), vector.encoded, `Base32 encode ${vector.name}`);
    assertEqual(
      bytesToHex(decodeSha256Base32(vector.encoded)),
      vector.digest_hex,
      `Base32 decode ${vector.name}`
    );
  }
  for (const vector of vectors.base32.rejected) {
    assertThrows(
      () => decodeSha256Base32(vector.encoded),
      `Base32 rejection ${vector.name}`
    );
  }

  const fixtures = createObjectFixtures();
  for (const vector of vectors.objects) {
    const derive = fixtures.objects[vector.name];
    const result = await derive();
    assertEqual(
      bytesToHex(result.canonical_bytes),
      vector.canonical_cbor_hex,
      `${vector.name} canonical bytes`
    );
    assertEqual(bytesToHex(result.digest), vector.sha256_hex, `${vector.name} digest`);
    assertEqual(encodeSha256Base32(result.digest), vector.base32, `${vector.name} Base32`);
    assertEqual(result.id, vector.display_id, `${vector.name} display ID`);
  }

  for (const vector of vectors.signatures) {
    const value = fixtures.signatures[vector.subject_kind]();
    assertEqual(
      bytesToHex(encodeCanonicalCbor(value)),
      vector.canonical_preimage_hex,
      `${vector.subject_kind} signature preimage`
    );
  }

  return Object.freeze({
    base32_vectors: vectors.base32.accepted.length + vectors.base32.rejected.length,
    cbor_vectors: vectors.cbor.accepted.length + vectors.cbor.rejected.length,
    object_vectors: vectors.objects.length,
    sha256_vectors: vectors.sha256.length,
    signature_vectors: vectors.signatures.length
  });
}

export function createObjectFixtures() {
  const ids = createIds();
  const semanticPayloadCore = parseSemanticPayloadCore({
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "revision_adoption" as const,
    data: {
      document_id: ids.document,
      revision_id: ids.revisionB
    }
  });
  const semanticPayloadRecord = parseSemanticPayloadRecord({
    record_version: 1,
    object_kind: "semantic_payload",
    payload_id: ids.payload,
    core: semanticPayloadCore
  });
  const semanticEventCoreInput = {
    schema_version: 1,
    object_kind: "semantic_event_core" as const,
    device_chain_position: "subsequent" as const,
    project_id: ids.project,
    semantic_kind: "revision_adoption" as const,
    author_device_id: ids.device,
    device_sequence: BigInt(7),
    previous_device_event_id: ids.eventA,
    causal_parent_event_ids: [ids.eventA, ids.eventB],
    authorizing_control_head_id: ids.controlEvent,
    key_epoch_id: ids.keyEpoch,
    semantic_payload_id: ids.payload,
    complete_known_frontier: true as const,
    display_timestamp: "2026-08-21T00:00:00.000Z"
  };
  const controlActionCore = parseControlActionCore({
    schema_version: 1,
    project_id: ids.project,
    action_kind: "membership_grant",
    membership_id: ids.membership,
    person_id: ids.person,
    role: "editor",
    access_scope_id: ids.accessScope
  });
  const controlEventCore = parseControlEventCore({
    schema_version: 1,
    object_kind: "control_event_core" as const,
    control_kind: "genesis" as const,
    project_id: ids.project,
    control_sequence: BigInt(0),
    previous_control_id: null,
    root_sequence: BigInt(0),
    previous_root_control_id: null,
    owner_person_id: ids.person,
    offline_root_key_id: ids.publicKey,
    initial_active_control_device_id: ids.device,
    initial_memberships: [
      {
        membership_id: ids.membership,
        person_id: ids.person,
        role: "owner" as const,
        access_scope_id: ids.accessScope,
        status: "active" as const
      }
    ],
    initial_authorized_devices: [
      {
        device_id: ids.device,
        person_id: ids.person,
        signing_key_id: ids.publicKey,
        status: "active" as const
      }
    ],
    initial_key_epoch_id: ids.keyEpoch,
    initial_key_epoch_commitment: ids.keyEpochCommitment,
    resulting_control_state_root: ids.controlStateRoot,
    display_timestamp: "2026-08-21T00:00:00.000Z"
  });
  const revisionCore = parseDocumentRevisionCore({
    schema_version: 1,
    object_kind: "document_revision_core" as const,
    ancestry_kind: "ordinary" as const,
    project_id: ids.project,
    document_id: ids.document,
    markdown_blob_id: ids.markdownBlob,
    parent_revision_ids: [ids.revisionA, ids.revisionB]
  });
  const mergeKeyCore = parseMergeKeyCore({
    schema_version: 1,
    object_kind: "merge_key_core" as const,
    project_id: ids.project,
    document_id: ids.document,
    parent_revision_ids: [ids.revisionA, ids.revisionB],
    base_revision_id: ids.revisionA,
    result_revision_id: ids.revisionC,
    merge_algorithm_id: "patchmark-merge",
    merge_algorithm_version: "v1"
  });
  const checkpointId = checkpointIdFromConsolidationEvent(
    ids.checkpointEvent,
    "consolidation_checkpoint"
  );
  const snapshotCore = parseProjectionSnapshotCore({
    schema_version: 1,
    object_kind: "projection_snapshot_core" as const,
    project_id: ids.project,
    checkpoint_id: checkpointId,
    reducer_version: "patchmark-hc-reducer-v1",
    state_blob_id: ids.stateBlob,
    semantic_state_root: ids.semanticStateRoot,
    revision_heads_root: ids.revisionHeadsRoot,
    conflict_set_root: ids.conflictSetRoot,
    projection_root: ids.projectionRoot,
    boundary_revisions: [
      {
        document_id: ids.document,
        revision_id: ids.revisionC,
        traversal: "complete" as const
      }
    ],
    live_conflict_dependencies: [ids.derivedConflict]
  }, checkpointId);
  const acknowledgementCore = parseAcknowledgementCore({
    schema_version: 1,
    object_kind: "acknowledgement_core" as const,
    chain_position: "first" as const,
    project_id: ids.project,
    device_id: ids.device,
    acknowledgement_sequence: BigInt(0),
    previous_acknowledgement_id: null,
    observed_control_head_id: ids.controlEvent,
    acknowledged_checkpoint_id: checkpointId,
    observed_semantic_frontier: [ids.checkpointEvent],
    projection_root: ids.projectionRoot,
    display_timestamp: "2026-08-21T00:00:00.000Z"
  }, checkpointId);
  const attestationCore = parseAttestationCore({
    schema_version: 1,
    object_kind: "attestation_core" as const,
    project_id: ids.project,
    subject_kind: "semantic_event" as const,
    subject_id: ids.eventA,
    signer_key_id: ids.publicKey,
    algorithm: "ed25519" as const,
    signature_bytes: Uint8Array.from([0, 1, 2, 3, 254, 255])
  });
  const conflictCore = parseDerivedConflictCore({
    schema_version: 1,
    conflict_kind: "content" as const,
    authority: "none" as const,
    project_id: ids.project,
    document_id: ids.document,
    contender_revision_ids: [ids.revisionA, ids.revisionB],
    base_revision_id: ids.revisionA
  });
  const semanticEventCore = parseSemanticEventCore(
    semanticEventCoreInput,
    semanticPayloadRecord
  );
  const markdown = new TextEncoder().encode("# Slice 2\r\n\r\nExact bytes.\n");

  return Object.freeze({
    ids,
    values: Object.freeze({
      acknowledgementCore,
      attestationCore,
      controlActionCore,
      controlEventCore,
      conflictCore,
      markdown,
      mergeKeyCore,
      revisionCore,
      semanticEventCore,
      semanticPayloadCore,
      semanticPayloadRecord,
      snapshotCore
    }),
    objects: Object.freeze({
      acknowledgement: () => deriveAcknowledgementIdentity(acknowledgementCore),
      attestation: () => deriveAttestationIdentity(attestationCore),
      control_action: () => deriveControlActionIdentity(controlActionCore),
      control_event: () => deriveControlEventIdentity(controlEventCore),
      derived_conflict: () => deriveDerivedConflictIdentity(conflictCore),
      document_revision: () => deriveDocumentRevisionIdentity(revisionCore),
      markdown_blob: () => deriveMarkdownBlobIdentity(ids.project, markdown),
      merge_key: () => deriveMergeKeyIdentity(mergeKeyCore),
      projection_snapshot: () => deriveProjectionSnapshotIdentity(snapshotCore),
      semantic_event: () =>
        deriveSemanticEventIdentity(semanticEventCore, semanticPayloadRecord),
      semantic_payload: () => deriveSemanticPayloadIdentity(semanticPayloadCore)
    }),
    signatures: Object.freeze({
      acknowledgement: () =>
        buildSignaturePreimage("acknowledgement", ids.project, ids.acknowledgement),
      control_event: () =>
        buildSignaturePreimage("control_event", ids.project, ids.controlEvent),
      semantic_event: () =>
        buildSignaturePreimage("semantic_event", ids.project, ids.eventA),
      snapshot: () => buildSignaturePreimage("snapshot", ids.project, ids.snapshot)
    })
  });
}

function canonicalFundamentals(): Map<string, ReturnType<typeof canonicalUint>> {
  const values = new Map<string, ReturnType<typeof canonicalUint>>();
  const add = (name: string, value: Parameters<typeof encodeCanonicalCbor>[0]) => {
    values.set(name, value as ReturnType<typeof canonicalUint>);
  };
  add("uint_0", canonicalUint(BigInt(0)));
  add("uint_23", canonicalUint(BigInt(23)));
  add("uint_24", canonicalUint(BigInt(24)));
  add("uint_255", canonicalUint(BigInt(255)));
  add("uint_256", canonicalUint(BigInt(256)));
  add("uint_65535", canonicalUint(BigInt(65535)));
  add("uint_65536", canonicalUint(BigInt(65536)));
  add("uint_2_32", canonicalUint(BigInt(1) << BigInt(32)));
  add("uint_2_64_minus_1", canonicalUint((BigInt(1) << BigInt(64)) - BigInt(1)));
  add("bytes_empty", canonicalBytes(new Uint8Array()));
  add("bytes_nonempty", canonicalBytes(Uint8Array.from([0, 255, 16])));
  add("text_empty", canonicalText(""));
  add("text_unicode_nfc", canonicalText("é"));
  add("array_dense", canonicalArray([
    canonicalUint(BigInt(0)),
    canonicalUint(BigInt(24)),
    canonicalBoolean(true),
    canonicalNull
  ]));
  add("map_reordered", canonicalMap([
    ["b", canonicalUint(BigInt(1))],
    ["a", canonicalUint(BigInt(2))]
  ]));
  add("map_encoded_byte_order", canonicalMap([
    ["é", canonicalUint(BigInt(1))],
    ["z", canonicalUint(BigInt(0))]
  ]));
  add("nested", canonicalArray([
    canonicalMap([["z", canonicalBoolean(false)]]),
    canonicalArray([canonicalText("é"), canonicalBytes(Uint8Array.from([255]))])
  ]));
  add("boolean_false", canonicalBoolean(false));
  add("boolean_true", canonicalBoolean(true));
  add("null", canonicalNull);
  return values;
}

function assertConstructionRejections(): void {
  assertThrows(() => canonicalText("e\u0301"), "non-NFC construction");
  assertThrows(() => canonicalText("\ud800"), "unpaired surrogate construction");
  const sparse = new Array(2);
  sparse[1] = canonicalNull;
  assertThrows(() => canonicalArray(sparse), "sparse array construction");
  assertThrows(
    () => encodeCanonicalCbor({} as Parameters<typeof encodeCanonicalCbor>[0]),
    "implicit object construction"
  );
}

function createIds() {
  return Object.freeze({
    accessScope: entity("access-scope"),
    acknowledgement: digest("acknowledgement", "b"),
    checkpointEvent: digest("semantic-event", "d"),
    conflictSetRoot: digest("conflict-set-root"),
    controlEvent: digest("control-event", "c"),
    controlStateRoot: digest("control-state-root"),
    derivedConflict: digest("derived-conflict"),
    device: entity("device"),
    document: entity("document"),
    eventA: digest("semantic-event", "b"),
    eventB: digest("semantic-event", "c"),
    keyEpoch: entity("key-epoch"),
    keyEpochCommitment: digest("key-epoch-commitment"),
    markdownBlob: digest("markdown-blob"),
    membership: entity("membership"),
    payload: digest("semantic-payload"),
    person: entity("person"),
    project: entity("project"),
    projectionRoot: digest("projection-root"),
    publicKey: entity("public-key"),
    revisionA: digest("document-revision"),
    revisionB: digest("document-revision", "b"),
    revisionC: digest("document-revision", "c"),
    revisionHeadsRoot: digest("revision-heads-root"),
    semanticStateRoot: digest("semantic-state-root"),
    snapshot: digest("snapshot", "e"),
    stateBlob: digest("state-blob")
  });
}

function entity(kind: string, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(24)}${marker}a` as never;
}

function digest(kind: string, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(50)}${marker}a` as never;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertThrows(operation: () => unknown, label: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${label} did not reject.`);
}

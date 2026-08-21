import {
  DERIVED_CONFLICT_SCHEMA_VERSION,
  INITIAL_REDUCER_VERSION,
  MERGE_KEY_CORE_SCHEMA_VERSION,
  MERGE_CANDIDATE_SCHEMA_VERSION
} from "./versions.ts";
import type { CollaborationRole } from "./capabilities.ts";
import {
  type ControlEventId,
  type DerivedConflictId,
  type DeviceId,
  type DocumentId,
  type DocumentRevisionId,
  type MergeKeyId,
  type ProjectId,
  type ProjectionRootId,
  type SemanticEventId,
  type SemanticPayloadId,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  expectEnum,
  expectExactRecord,
  expectLiteral,
  freezeRecord,
  parseSortedUniqueArray
} from "./validation.ts";

export const mergeOutcomeClassifications = [
  "identical",
  "proven_safe",
  "requires_resolution"
] as const;

export type MergeOutcomeClassification =
  (typeof mergeOutcomeClassifications)[number];

/**
 * The complete identity preimage for a deterministic merge key. Slice 2 will
 * encode and hash this core; authority, authorship, signatures, and time are
 * deliberately outside it.
 */
export type MergeKeyCore = Readonly<{
  schema_version: typeof MERGE_KEY_CORE_SCHEMA_VERSION;
  object_kind: "merge_key_core";
  project_id: ProjectId;
  document_id: DocumentId;
  parent_revision_ids: readonly DocumentRevisionId[];
  base_revision_id: DocumentRevisionId | null;
  result_revision_id: DocumentRevisionId;
  merge_algorithm_id: string;
  merge_algorithm_version: string;
}>;

export type DeterministicMergeCandidate = Readonly<{
  schema_version: typeof MERGE_CANDIDATE_SCHEMA_VERSION;
  object_kind: "deterministic_merge_candidate";
  authority: "none";
  merge_key_id: MergeKeyId;
  merge_key_core: MergeKeyCore;
  outcome: MergeOutcomeClassification;
}>;

export type ExplicitMergeAuthorization = Readonly<{
  schema_version: 1;
  object_kind: "merge_authorization";
  authorization_mode: "explicit_editor";
  merge_key_id: MergeKeyId;
  authorizing_device_id: DeviceId;
  authorizing_role: "owner" | "editor";
}>;

export type PolicySafeMergeAuthorization = Readonly<{
  schema_version: 1;
  object_kind: "merge_authorization";
  authorization_mode: "policy_authorized_proven_safe";
  merge_key_id: MergeKeyId;
  eligible_device_id: DeviceId;
  eligible_role: "owner" | "editor";
  policy_control_head_id: ControlEventId;
  required_outcome: "proven_safe";
}>;

export type MergeAuthorization =
  | ExplicitMergeAuthorization
  | PolicySafeMergeAuthorization;

export type ImmutableMergeRevisionReference = Readonly<{
  reference_kind: "immutable_merge_revision";
  revision_id: DocumentRevisionId;
  merge_key_id: MergeKeyId;
}>;

export type AuthenticatedMergeEventReference = Readonly<{
  reference_kind: "authenticated_merge_event";
  semantic_event_id: SemanticEventId;
  revision_id: DocumentRevisionId;
  merge_key_id: MergeKeyId;
}>;

export type ResolvedCheckpointReference = Readonly<{
  reference_kind: "resolved_checkpoint";
  checkpoint_event_id: SemanticEventId;
  projection_root: ProjectionRootId;
}>;

type DerivedConflictBase<TKind extends string> = Readonly<{
  schema_version: typeof DERIVED_CONFLICT_SCHEMA_VERSION;
  conflict_kind: TKind;
  authority: "none";
  project_id: ProjectId;
}>;

export type DerivedContentConflict = DerivedConflictBase<"content"> &
  Readonly<{
    document_id: DocumentId;
    contender_revision_ids: readonly DocumentRevisionId[];
    base_revision_id: DocumentRevisionId | null;
  }>;

export type DerivedMetadataConflict = DerivedConflictBase<"metadata"> &
  Readonly<{
    subject_kind: "project" | "document" | "group" | "comment" | "reply" | "patch";
    subject_id: string;
    field: string;
    contender_payload_ids: readonly SemanticPayloadId[];
  }>;

export type DerivedTombstoneConflict = DerivedConflictBase<"tombstone"> &
  Readonly<{
    subject_kind: "document" | "comment" | "reply" | "patch";
    subject_id: string;
    tombstone_event_id: SemanticEventId;
    contender_event_ids: readonly SemanticEventId[];
  }>;

export const reducerConflictKinds = [
  "field_value",
  "decision",
  "tombstone",
  "alias_path",
  "status",
  "revision",
  "unresolved_reference",
  "lifecycle"
] as const;

export type ReducerConflictKind = (typeof reducerConflictKinds)[number];

/**
 * Slice 5's strict conflict identity. Earlier Slice 1 conflict variants remain
 * valid; projector-derived conflicts use this fully committed reducer shape.
 */
export type DerivedReducerConflict = DerivedConflictBase<"reducer"> &
  Readonly<{
    reducer_version: typeof INITIAL_REDUCER_VERSION;
    reducer_conflict_kind: ReducerConflictKind;
    subject_kind:
      | "project"
      | "document"
      | "group"
      | "comment"
      | "reply"
      | "patch"
      | "review_batch"
      | "rewrite_session";
    subject_id: string;
    field: string;
    base_value_commitment: string | null;
    contender_event_ids: readonly SemanticEventId[];
    contender_value_commitments: readonly string[];
    context_event_ids: readonly SemanticEventId[];
  }>;

export type DerivedConflictCore =
  | DerivedContentConflict
  | DerivedMetadataConflict
  | DerivedTombstoneConflict
  | DerivedReducerConflict;

export type DerivedConflictRecord = Readonly<{
  record_version: 1;
  object_kind: "derived_conflict";
  conflict_id: DerivedConflictId;
  core: DerivedConflictCore;
}>;

export function parseMergeKeyCore(value: unknown): MergeKeyCore {
  const record = expectExactRecord(value, "merge key core", [
    "schema_version",
    "object_kind",
    "project_id",
    "document_id",
    "parent_revision_ids",
    "base_revision_id",
    "result_revision_id",
    "merge_algorithm_id",
    "merge_algorithm_version"
  ]);
  expectLiteral(
    record.schema_version,
    MERGE_KEY_CORE_SCHEMA_VERSION,
    "merge key core schema version"
  );
  expectLiteral(record.object_kind, "merge_key_core", "merge key core kind");
  const parents = parseSortedUniqueArray(
    record.parent_revision_ids,
    "merge key parent revision IDs",
    (candidate) => parseDigestId("document-revision", candidate)
  );
  if (parents.length < 2) {
    throw new Error("A merge key requires at least two parent revisions.");
  }
  return freezeRecord({
    schema_version: MERGE_KEY_CORE_SCHEMA_VERSION,
    object_kind: "merge_key_core" as const,
    project_id: parseEntityId("project", record.project_id),
    document_id: parseEntityId("document", record.document_id),
    parent_revision_ids: parents,
    base_revision_id:
      record.base_revision_id === null
        ? null
        : parseDigestId("document-revision", record.base_revision_id),
    result_revision_id: parseDigestId(
      "document-revision",
      record.result_revision_id
    ),
    merge_algorithm_id: parseAlgorithmVersion(
      record.merge_algorithm_id,
      "merge algorithm ID"
    ),
    merge_algorithm_version: parseAlgorithmVersion(
      record.merge_algorithm_version,
      "merge algorithm version"
    )
  });
}

export function parseDeterministicMergeCandidate(
  value: unknown
): DeterministicMergeCandidate {
  const record = expectExactRecord(value, "merge candidate", [
    "schema_version",
    "object_kind",
    "authority",
    "merge_key_id",
    "merge_key_core",
    "outcome"
  ]);
  expectLiteral(
    record.schema_version,
    MERGE_CANDIDATE_SCHEMA_VERSION,
    "merge candidate schema version"
  );
  expectLiteral(
    record.object_kind,
    "deterministic_merge_candidate",
    "merge candidate object kind"
  );
  expectLiteral(record.authority, "none", "merge candidate authority");
  return freezeRecord({
    schema_version: MERGE_CANDIDATE_SCHEMA_VERSION,
    object_kind: "deterministic_merge_candidate" as const,
    authority: "none" as const,
    merge_key_id: parseDigestId("merge-key", record.merge_key_id),
    merge_key_core: parseMergeKeyCore(record.merge_key_core),
    outcome: expectEnum(
      record.outcome,
      mergeOutcomeClassifications,
      "merge outcome"
    )
  });
}

export function parseMergeAuthorization(value: unknown): MergeAuthorization {
  const discriminator = expectExactRecord(
    value,
    "merge authorization",
    ["schema_version", "object_kind", "authorization_mode", "merge_key_id"],
    [
      "authorizing_device_id",
      "authorizing_role",
      "eligible_device_id",
      "eligible_role",
      "policy_control_head_id",
      "required_outcome"
    ]
  );
  expectLiteral(
    discriminator.schema_version,
    1,
    "merge authorization schema version"
  );
  expectLiteral(
    discriminator.object_kind,
    "merge_authorization",
    "merge authorization object kind"
  );
  const mode = expectEnum(
    discriminator.authorization_mode,
    ["explicit_editor", "policy_authorized_proven_safe"] as const,
    "merge authorization mode"
  );
  const mergeKeyId = parseDigestId("merge-key", discriminator.merge_key_id);
  if (mode === "explicit_editor") {
    assertKeysPresent(discriminator, ["authorizing_device_id", "authorizing_role"]);
    assertKeysAbsent(discriminator, [
      "eligible_device_id",
      "eligible_role",
      "policy_control_head_id",
      "required_outcome"
    ]);
    return freezeRecord({
      schema_version: 1,
      object_kind: "merge_authorization" as const,
      authorization_mode: "explicit_editor" as const,
      merge_key_id: mergeKeyId,
      authorizing_device_id: parseEntityId(
        "device",
        discriminator.authorizing_device_id
      ),
      authorizing_role: parseEditorRole(discriminator.authorizing_role)
    });
  }

  assertKeysPresent(discriminator, [
    "eligible_device_id",
    "eligible_role",
    "policy_control_head_id",
    "required_outcome"
  ]);
  assertKeysAbsent(discriminator, ["authorizing_device_id", "authorizing_role"]);
  expectLiteral(
    discriminator.required_outcome,
    "proven_safe",
    "policy merge required outcome"
  );
  return freezeRecord({
    schema_version: 1,
    object_kind: "merge_authorization" as const,
    authorization_mode: "policy_authorized_proven_safe" as const,
    merge_key_id: mergeKeyId,
    eligible_device_id: parseEntityId("device", discriminator.eligible_device_id),
    eligible_role: parseEditorRole(discriminator.eligible_role),
    policy_control_head_id: parseDigestId(
      "control-event",
      discriminator.policy_control_head_id
    ),
    required_outcome: "proven_safe" as const
  });
}

export function parseDerivedConflictRecord(
  value: unknown
): DerivedConflictRecord {
  const record = expectExactRecord(value, "derived conflict record", [
    "record_version",
    "object_kind",
    "conflict_id",
    "core"
  ]);
  expectLiteral(record.record_version, 1, "derived conflict record version");
  expectLiteral(
    record.object_kind,
    "derived_conflict",
    "derived conflict object kind"
  );
  return freezeRecord({
    record_version: 1,
    object_kind: "derived_conflict" as const,
    conflict_id: parseDigestId("derived-conflict", record.conflict_id),
    core: parseDerivedConflictCore(record.core)
  });
}

export function parseDerivedConflictCore(value: unknown): DerivedConflictCore {
  const discriminator = expectExactRecord(
    value,
    "derived conflict core",
    ["schema_version", "conflict_kind", "authority", "project_id"],
    [
      "document_id",
      "contender_revision_ids",
      "base_revision_id",
      "subject_kind",
      "subject_id",
      "field",
      "contender_payload_ids",
      "tombstone_event_id",
      "contender_event_ids",
      "reducer_version",
      "reducer_conflict_kind",
      "base_value_commitment",
      "contender_value_commitments",
      "context_event_ids"
    ]
  );
  expectLiteral(
    discriminator.schema_version,
    DERIVED_CONFLICT_SCHEMA_VERSION,
    "derived conflict schema version"
  );
  expectLiteral(discriminator.authority, "none", "derived conflict authority");
  const projectId = parseEntityId("project", discriminator.project_id);
  const conflictKind = expectEnum(
    discriminator.conflict_kind,
    ["content", "metadata", "tombstone", "reducer"] as const,
    "derived conflict kind"
  );

  if (conflictKind === "content") {
    assertKeysPresent(discriminator, [
      "document_id",
      "contender_revision_ids",
      "base_revision_id"
    ]);
    assertOnlyVariantKeys(discriminator, [
      "document_id",
      "contender_revision_ids",
      "base_revision_id"
    ]);
    return freezeRecord({
      schema_version: DERIVED_CONFLICT_SCHEMA_VERSION,
      conflict_kind: "content" as const,
      authority: "none" as const,
      project_id: projectId,
      document_id: parseEntityId("document", discriminator.document_id),
      contender_revision_ids: parseSortedUniqueArray(
        discriminator.contender_revision_ids,
        "content conflict contenders",
        (candidate) => parseDigestId("document-revision", candidate)
      ),
      base_revision_id:
        discriminator.base_revision_id === null
          ? null
          : parseDigestId("document-revision", discriminator.base_revision_id)
    });
  }

  if (conflictKind === "metadata") {
    assertKeysPresent(discriminator, [
      "subject_kind",
      "subject_id",
      "field",
      "contender_payload_ids"
    ]);
    assertOnlyVariantKeys(discriminator, [
      "subject_kind",
      "subject_id",
      "field",
      "contender_payload_ids"
    ]);
    return freezeRecord({
      schema_version: DERIVED_CONFLICT_SCHEMA_VERSION,
      conflict_kind: "metadata" as const,
      authority: "none" as const,
      project_id: projectId,
      subject_kind: expectEnum(
        discriminator.subject_kind,
        ["project", "document", "group", "comment", "reply", "patch"] as const,
        "metadata conflict subject kind"
      ),
      subject_id: parseSubjectId(
        discriminator.subject_kind,
        discriminator.subject_id
      ),
      field: parseAlgorithmVersion(discriminator.field, "metadata field"),
      contender_payload_ids: parseSortedUniqueArray(
        discriminator.contender_payload_ids,
        "metadata conflict contenders",
        (candidate) => parseDigestId("semantic-payload", candidate)
      )
    });
  }

  if (conflictKind === "reducer") {
    assertKeysPresent(discriminator, [
      "reducer_version",
      "reducer_conflict_kind",
      "subject_kind",
      "subject_id",
      "field",
      "base_value_commitment",
      "contender_event_ids",
      "contender_value_commitments",
      "context_event_ids"
    ]);
    assertOnlyVariantKeys(discriminator, [
      "reducer_version",
      "reducer_conflict_kind",
      "subject_kind",
      "subject_id",
      "field",
      "base_value_commitment",
      "contender_event_ids",
      "contender_value_commitments",
      "context_event_ids"
    ]);
    expectLiteral(
      discriminator.reducer_version,
      INITIAL_REDUCER_VERSION,
      "derived reducer version"
    );
    const subjectKind = expectEnum(
      discriminator.subject_kind,
      [
        "project",
        "document",
        "group",
        "comment",
        "reply",
        "patch",
        "review_batch",
        "rewrite_session"
      ] as const,
      "reducer conflict subject kind"
    );
    return freezeRecord({
      schema_version: DERIVED_CONFLICT_SCHEMA_VERSION,
      conflict_kind: "reducer" as const,
      authority: "none" as const,
      project_id: projectId,
      reducer_version: INITIAL_REDUCER_VERSION,
      reducer_conflict_kind: expectEnum(
        discriminator.reducer_conflict_kind,
        reducerConflictKinds,
        "reducer conflict kind"
      ),
      subject_kind: subjectKind,
      subject_id: parseReducerSubjectId(
        subjectKind,
        discriminator.subject_id
      ),
      field: parseAlgorithmVersion(discriminator.field, "reducer field"),
      base_value_commitment: parseOptionalCommitment(
        discriminator.base_value_commitment,
        "base value commitment"
      ),
      contender_event_ids: parseSortedUniqueArray(
        discriminator.contender_event_ids,
        "reducer contender event IDs",
        (candidate) => parseDigestId("semantic-event", candidate)
      ),
      contender_value_commitments: parseSortedUniqueArray(
        discriminator.contender_value_commitments,
        "reducer contender value commitments",
        (candidate) => parseCommitment(candidate),
        { allowEmpty: true }
      ),
      context_event_ids: parseSortedUniqueArray(
        discriminator.context_event_ids,
        "reducer context event IDs",
        (candidate) => parseDigestId("semantic-event", candidate),
        { allowEmpty: true }
      )
    });
  }

  assertKeysPresent(discriminator, [
    "subject_kind",
    "subject_id",
    "tombstone_event_id",
    "contender_event_ids"
  ]);
  assertOnlyVariantKeys(discriminator, [
    "subject_kind",
    "subject_id",
    "tombstone_event_id",
    "contender_event_ids"
  ]);
  return freezeRecord({
    schema_version: DERIVED_CONFLICT_SCHEMA_VERSION,
    conflict_kind: "tombstone" as const,
    authority: "none" as const,
    project_id: projectId,
    subject_kind: expectEnum(
      discriminator.subject_kind,
      ["document", "comment", "reply", "patch"] as const,
      "tombstone subject kind"
    ),
    subject_id: parseSubjectId(
      discriminator.subject_kind,
      discriminator.subject_id
    ),
    tombstone_event_id: parseDigestId(
      "semantic-event",
      discriminator.tombstone_event_id
    ),
    contender_event_ids: parseSortedUniqueArray(
      discriminator.contender_event_ids,
      "tombstone conflict contenders",
      (candidate) => parseDigestId("semantic-event", candidate)
    )
  });
}

function parseEditorRole(value: unknown): "owner" | "editor" {
  return expectEnum(
    value,
    ["owner", "editor"] as const satisfies readonly CollaborationRole[],
    "merge authorizing role"
  );
}

function parseAlgorithmVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a lowercase protocol token.`);
  }
  return value;
}

function parseSubjectId(kind: unknown, value: unknown): string {
  const subjectKind = expectEnum(
    kind,
    ["project", "document", "group", "comment", "reply", "patch"] as const,
    "conflict subject kind"
  );
  return parseEntityId(subjectKind, value);
}

function parseReducerSubjectId(
  kind: DerivedReducerConflict["subject_kind"],
  value: unknown
): string {
  if (kind === "review_batch") return parseEntityId("review-batch", value);
  if (kind === "rewrite_session") {
    return parseEntityId("rewrite-session", value);
  }
  return parseSubjectId(kind, value);
}

function parseOptionalCommitment(value: unknown, label: string): string | null {
  return value === null ? null : parseCommitment(value, label);
}

function parseCommitment(value: unknown, label = "value commitment"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a digest commitment.`);
  }
  if (/^sha256:[0-9a-f]{64}$/.test(value)) {
    return value;
  }
  for (const kind of [
    "semantic-payload",
    "document-revision",
    "semantic-event"
  ] as const) {
    try {
      return parseDigestId(kind, value);
    } catch {
      // Try the next permitted commitment namespace.
    }
  }
  throw new Error(`${label} must use a supported digest commitment namespace.`);
}

const baseConflictKeys = new Set([
  "schema_version",
  "conflict_kind",
  "authority",
  "project_id"
]);

function assertOnlyVariantKeys(
  record: Readonly<Record<string, unknown>>,
  variantKeys: readonly string[]
): void {
  const allowed = new Set([...baseConflictKeys, ...variantKeys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`derived conflict ${record.conflict_kind} cannot contain ${key}.`);
    }
  }
}

function assertKeysPresent(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Contract is missing required field ${key}.`);
    }
  }
}

function assertKeysAbsent(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Contract cannot contain ${key}.`);
    }
  }
}

import type { AttestationRecord } from "./checkpoints.ts";
import type { CollaborationRole } from "./capabilities.ts";
import type { DocumentRevisionRecord, MarkdownBlobDescription } from "./content.ts";
import {
  parseDerivedConflictRecord,
  type DerivedConflictRecord
} from "./derived.ts";
import type { DeviceAuthorityFact } from "./event-control-types.ts";
import {
  parseDigestId,
  parseEntityId,
  type CommentId,
  type AcceptedHistoryRootId,
  type AttestationId,
  type ControlEventId,
  type DeviceId,
  type DocumentId,
  type DocumentRevisionId,
  type GroupId,
  type MarkdownBlobId,
  type PatchId,
  type PatchVersionId,
  type ProjectId,
  type ReplyId,
  type ReviewBatchId,
  type RewriteSessionId,
  type SemanticEventId,
  type SemanticPayloadId
} from "./identities.ts";
import type { SemanticEventRecord, SemanticPayloadRecord } from "./semantic.ts";
import type { CollaborationReadResult } from "./storage.ts";
import {
  INITIAL_REDUCER_VERSION,
  PROJECTION_SCHEMA_VERSION
} from "./versions.ts";
import {
  expectArray,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectString
} from "./validation.ts";

export const projectionErrorCodes = [
  "invalid_input",
  "missing_dependency",
  "corrupted_dependency",
  "cross_project_dependency",
  "inconsistent_dependency",
  "unsupported_protocol",
  "causal_cycle",
  "frontier_mismatch",
  "revision_closure_invalid"
] as const;

export type ProjectionErrorCode = (typeof projectionErrorCodes)[number];

export class CollaborationProjectionError extends Error {
  readonly code: ProjectionErrorCode;
  readonly dependency_id: string | null;

  constructor(
    code: ProjectionErrorCode,
    message: string,
    dependencyId: string | null = null
  ) {
    super(message);
    this.name = "CollaborationProjectionError";
    this.code = code;
    this.dependency_id = dependencyId;
  }
}

export type AcceptedControlProjectionFacts = Readonly<{
  control_event_id: ControlEventId;
  merge_policy: "manual" | "auto_safe";
  device_authorities: readonly DeviceAuthorityFact[];
}>;

export type ProjectionOnboardingBoundary = Readonly<{
  boundary_event_id: SemanticEventId;
  unavailable_parent_event_ids: readonly SemanticEventId[];
  sealed_history_root: AcceptedHistoryRootId;
}>;

/**
 * The complete Slice 5 authority boundary. It exposes reads and accepted facts
 * only; no mutable store or writer interface is accepted by the projector.
 */
export type CollaborationProjectorInput = Readonly<{
  project_id: ProjectId;
  accepted_semantic_event_ids: readonly SemanticEventId[];
  accepted_semantic_frontier: readonly SemanticEventId[];
  accepted_control_facts: readonly AcceptedControlProjectionFacts[];
  onboarding_boundaries: readonly ProjectionOnboardingBoundary[];
  read_event: (
    eventId: SemanticEventId
  ) => Promise<CollaborationReadResult<SemanticEventRecord>>;
  read_payload: (
    payloadId: SemanticPayloadId
  ) => Promise<CollaborationReadResult<SemanticPayloadRecord>>;
  read_revision: (
    revisionId: DocumentRevisionId
  ) => Promise<CollaborationReadResult<DocumentRevisionRecord>>;
  read_blob: (
    projectId: ProjectId,
    blobId: MarkdownBlobId
  ) => Promise<CollaborationReadResult<MarkdownBlobDescription>>;
  read_attestation: (
    attestationId: AttestationId
  ) => Promise<CollaborationReadResult<AttestationRecord>>;
}>;

export type ProjectedValueContender = Readonly<{
  value: string;
  value_commitment: string;
  event_ids: readonly SemanticEventId[];
  payload_ids: readonly SemanticPayloadId[];
}>;

export type ProjectedValueRegister = Readonly<{
  register_version: 1;
  state: "unset" | "resolved" | "conflicted";
  resolved_value: string | null;
  last_uncontested_value: string | null;
  contenders: readonly ProjectedValueContender[];
}>;

export type ProjectedTombstone = Readonly<{
  tombstone_version: 1;
  deletion_event_ids: readonly SemanticEventId[];
  deletion_payload_ids: readonly SemanticPayloadId[];
  contender_event_ids: readonly SemanticEventId[];
}>;

export type ProjectedReply = Readonly<{
  reply_id: ReplyId;
  comment_id: CommentId;
  document_id: DocumentId;
  body: ProjectedValueRegister;
  tombstone: ProjectedTombstone | null;
  creation_event_ids: readonly SemanticEventId[];
}>;

export type ProjectedComment = Readonly<{
  comment_id: CommentId;
  document_id: DocumentId;
  body: ProjectedValueRegister;
  anchor: ProjectedValueRegister;
  status: ProjectedValueRegister;
  replies: readonly ProjectedReply[];
  tombstone: ProjectedTombstone | null;
  creation_event_ids: readonly SemanticEventId[];
}>;

export type ProjectedPatchVersion = Readonly<{
  patch_version_id: PatchVersionId;
  revision_id: DocumentRevisionId | null;
  dependency_patch_version_ids: readonly PatchVersionId[];
  target_provenance: string | null;
  proposal_event_ids: readonly SemanticEventId[];
  proposal_payload_ids: readonly SemanticPayloadId[];
  decision: ProjectedValueRegister;
}>;

export type ProjectedPatch = Readonly<{
  patch_id: PatchId;
  document_id: DocumentId;
  versions: readonly ProjectedPatchVersion[];
}>;

export type ProjectedReviewBatch = Readonly<{
  review_batch_id: ReviewBatchId;
  lifecycle: ProjectedValueRegister;
  responses: ProjectedValueRegister;
  contribution_payload_ids: readonly SemanticPayloadId[];
  creation_event_ids: readonly SemanticEventId[];
}>;

export type ProjectedRewriteSession = Readonly<{
  rewrite_session_id: RewriteSessionId;
  document_id: DocumentId;
  outcome: ProjectedValueRegister;
  applied_revision_ids: readonly DocumentRevisionId[];
  creation_event_ids: readonly SemanticEventId[];
}>;

export type ProjectedDocumentReference = Readonly<{
  target_document_id: DocumentId;
  event_ids: readonly SemanticEventId[];
  state: "available" | "unresolved";
}>;

export type ProjectedRevisionAdoption = Readonly<{
  revision_id: DocumentRevisionId;
  adopting_event_ids: readonly SemanticEventId[];
  adopting_payload_ids: readonly SemanticPayloadId[];
  author_device_ids: readonly DeviceId[];
  author_roles: readonly ("owner" | "editor")[];
  attestation_ids: readonly AttestationId[];
  adoption_kinds: readonly (
    | "genesis"
    | "revision"
    | "merge"
    | "patch_acceptance"
    | "rewrite_apply"
    | "conflict_resolution"
  )[];
  is_head: boolean;
  superseded_by_revision_ids: readonly DocumentRevisionId[];
}>;

export type ProjectedDocumentRevisionHeads = Readonly<{
  document_id: DocumentId;
  head_revision_ids: readonly DocumentRevisionId[];
  adoptions: readonly ProjectedRevisionAdoption[];
}>;

export type ProjectedDocument = Readonly<{
  document_id: DocumentId;
  title: ProjectedValueRegister;
  logical_path: ProjectedValueRegister;
  position: ProjectedValueRegister;
  group: ProjectedValueRegister;
  archive_status: ProjectedValueRegister;
  tombstone: ProjectedTombstone | null;
  creation_event_ids: readonly SemanticEventId[];
  comments: readonly ProjectedComment[];
  patches: readonly ProjectedPatch[];
  references: readonly ProjectedDocumentReference[];
}>;

export type ProjectedGroup = Readonly<{
  group_id: GroupId;
  title: ProjectedValueRegister;
  position: ProjectedValueRegister;
  creation_event_ids: readonly SemanticEventId[];
}>;

export type ProjectionReductionRejection = Readonly<{
  rejection_version: 1;
  event_id: SemanticEventId;
  payload_id: SemanticPayloadId;
  reason:
    | "missing_subject"
    | "duplicate_identity"
    | "invalid_transition"
    | "permanently_deleted"
    | "unobserved_conflict"
    | "unauthorized_revision_adoption"
    | "invalid_revision"
    | "unsupported_payload";
  detail: string;
}>;

export type ProjectedEventProvenance = Readonly<{
  event_id: SemanticEventId;
  payload_id: SemanticPayloadId;
  author_device_id: DeviceId;
  author_role: CollaborationRole;
  author_attestation_ids: readonly AttestationId[];
  control_head_id: ControlEventId;
}>;

export type CollaborationProjection = Readonly<{
  schema_version: typeof PROJECTION_SCHEMA_VERSION;
  object_kind: "collaboration_projection";
  reducer_version: typeof INITIAL_REDUCER_VERSION;
  project_id: ProjectId;
  project_title: ProjectedValueRegister;
  group_order: readonly GroupId[];
  groups: readonly ProjectedGroup[];
  document_order: readonly DocumentId[];
  documents: readonly ProjectedDocument[];
  review_batches: readonly ProjectedReviewBatch[];
  rewrite_sessions: readonly ProjectedRewriteSession[];
  revision_heads: readonly ProjectedDocumentRevisionHeads[];
  conflicts: readonly DerivedConflictRecord[];
  reduction_rejections: readonly ProjectionReductionRejection[];
  replayed_event_ids: readonly SemanticEventId[];
  accepted_frontier: readonly SemanticEventId[];
  event_provenance: readonly ProjectedEventProvenance[];
}>;

export type ProjectionReplayResult = Readonly<{
  projection: CollaborationProjection;
  topological_event_ids: readonly SemanticEventId[];
}>;

export function parseCollaborationProjection(
  value: unknown
): CollaborationProjection {
  const record = expectExactRecord(value, "collaboration projection", [
    "schema_version",
    "object_kind",
    "reducer_version",
    "project_id",
    "project_title",
    "group_order",
    "groups",
    "document_order",
    "documents",
    "review_batches",
    "rewrite_sessions",
    "revision_heads",
    "conflicts",
    "reduction_rejections",
    "replayed_event_ids",
    "accepted_frontier",
    "event_provenance"
  ]);
  expectLiteral(
    record.schema_version,
    PROJECTION_SCHEMA_VERSION,
    "projection schema version"
  );
  expectLiteral(
    record.object_kind,
    "collaboration_projection",
    "projection object kind"
  );
  expectLiteral(
    record.reducer_version,
    INITIAL_REDUCER_VERSION,
    "projection reducer version"
  );
  parseEntityId("project", record.project_id);
  validateRegister(record.project_title, "project title");
  validateUniqueIds(record.group_order, "group", "group order");
  validateSortedRecords(
    record.groups,
    "projected groups",
    "group_id",
    validateGroup
  );
  validateUniqueIds(record.document_order, "document", "document order");
  validateSortedRecords(
    record.documents,
    "projected documents",
    "document_id",
    validateDocument
  );
  validateSortedRecords(
    record.review_batches,
    "projected review batches",
    "review_batch_id",
    validateReviewBatch
  );
  validateSortedRecords(
    record.rewrite_sessions,
    "projected rewrite sessions",
    "rewrite_session_id",
    validateRewriteSession
  );
  validateSortedRecords(
    record.revision_heads,
    "projected revision heads",
    "document_id",
    validateRevisionHeads
  );
  for (const conflict of expectArray(record.conflicts, "projection conflicts")) {
    parseDerivedConflictRecord(conflict);
  }
  validateSortedRecords(
    record.reduction_rejections,
    "projection reduction rejections",
    "event_id",
    validateRejection
  );
  validateUniqueIds(record.replayed_event_ids, "semantic-event", "replayed events");
  validateSortedIds(record.accepted_frontier, "semantic-event", "accepted frontier");
  validateSortedRecords(
    record.event_provenance,
    "projection event provenance",
    "event_id",
    validateEventProvenance
  );
  return value as CollaborationProjection;
}

function validateGroup(value: unknown): void {
  const record = expectExactRecord(value, "projected group", [
    "group_id",
    "title",
    "position",
    "creation_event_ids"
  ]);
  parseEntityId("group", record.group_id);
  validateRegister(record.title, "group title");
  validateRegister(record.position, "group position");
  validateSortedIds(record.creation_event_ids, "semantic-event", "group creation events");
}

function validateDocument(value: unknown): void {
  const record = expectExactRecord(value, "projected document", [
    "document_id",
    "title",
    "logical_path",
    "position",
    "group",
    "archive_status",
    "tombstone",
    "creation_event_ids",
    "comments",
    "patches",
    "references"
  ]);
  parseEntityId("document", record.document_id);
  for (const [field, label] of [
    ["title", "document title"],
    ["logical_path", "document path"],
    ["position", "document position"],
    ["group", "document group"],
    ["archive_status", "document archive status"]
  ] as const) validateRegister(record[field], label);
  validateTombstone(record.tombstone, "document tombstone");
  validateSortedIds(record.creation_event_ids, "semantic-event", "document creation events");
  validateSortedRecords(record.comments, "projected comments", "comment_id", validateComment);
  validateSortedRecords(record.patches, "projected patches", "patch_id", validatePatch);
  validateSortedRecords(record.references, "projected references", "target_document_id", (candidate) => {
    const reference = expectExactRecord(candidate, "projected document reference", [
      "target_document_id",
      "event_ids",
      "state"
    ]);
    parseEntityId("document", reference.target_document_id);
    validateSortedIds(reference.event_ids, "semantic-event", "reference events");
    expectEnum(reference.state, ["available", "unresolved"] as const, "reference state");
  });
}

function validateComment(value: unknown): void {
  const record = expectExactRecord(value, "projected comment", [
    "comment_id",
    "document_id",
    "body",
    "anchor",
    "status",
    "replies",
    "tombstone",
    "creation_event_ids"
  ]);
  parseEntityId("comment", record.comment_id);
  parseEntityId("document", record.document_id);
  validateRegister(record.body, "comment body");
  validateRegister(record.anchor, "comment anchor");
  validateRegister(record.status, "comment status");
  validateSortedRecords(record.replies, "projected replies", "reply_id", validateReply);
  validateTombstone(record.tombstone, "comment tombstone");
  validateSortedIds(record.creation_event_ids, "semantic-event", "comment creation events");
}

function validateReply(value: unknown): void {
  const record = expectExactRecord(value, "projected reply", [
    "reply_id",
    "comment_id",
    "document_id",
    "body",
    "tombstone",
    "creation_event_ids"
  ]);
  parseEntityId("reply", record.reply_id);
  parseEntityId("comment", record.comment_id);
  parseEntityId("document", record.document_id);
  validateRegister(record.body, "reply body");
  validateTombstone(record.tombstone, "reply tombstone");
  validateSortedIds(record.creation_event_ids, "semantic-event", "reply creation events");
}

function validatePatch(value: unknown): void {
  const record = expectExactRecord(value, "projected patch", [
    "patch_id",
    "document_id",
    "versions"
  ]);
  parseEntityId("patch", record.patch_id);
  parseEntityId("document", record.document_id);
  validateSortedRecords(record.versions, "projected patch versions", "patch_version_id", (candidate) => {
    const version = expectExactRecord(candidate, "projected patch version", [
      "patch_version_id",
      "revision_id",
      "dependency_patch_version_ids",
      "target_provenance",
      "proposal_event_ids",
      "proposal_payload_ids",
      "decision"
    ]);
    parseEntityId("patch-version", version.patch_version_id);
    if (version.revision_id !== null) parseDigestId("document-revision", version.revision_id);
    validateSortedIds(version.dependency_patch_version_ids, "patch-version", "patch dependencies");
    if (version.target_provenance !== null) expectString(version.target_provenance, "patch provenance");
    validateSortedIds(version.proposal_event_ids, "semantic-event", "patch proposal events");
    validateSortedIds(version.proposal_payload_ids, "semantic-payload", "patch proposal payloads");
    validateRegister(version.decision, "patch decision");
  });
}

function validateReviewBatch(value: unknown): void {
  const record = expectExactRecord(value, "projected review batch", [
    "review_batch_id",
    "lifecycle",
    "responses",
    "contribution_payload_ids",
    "creation_event_ids"
  ]);
  parseEntityId("review-batch", record.review_batch_id);
  validateRegister(record.lifecycle, "review lifecycle");
  validateRegister(record.responses, "review responses");
  validateSortedIds(record.contribution_payload_ids, "semantic-payload", "review contributions");
  validateSortedIds(record.creation_event_ids, "semantic-event", "review creation events");
}

function validateRewriteSession(value: unknown): void {
  const record = expectExactRecord(value, "projected rewrite session", [
    "rewrite_session_id",
    "document_id",
    "outcome",
    "applied_revision_ids",
    "creation_event_ids"
  ]);
  parseEntityId("rewrite-session", record.rewrite_session_id);
  parseEntityId("document", record.document_id);
  validateRegister(record.outcome, "rewrite outcome");
  validateSortedIds(record.applied_revision_ids, "document-revision", "rewrite revisions");
  validateSortedIds(record.creation_event_ids, "semantic-event", "rewrite creation events");
}

function validateRevisionHeads(value: unknown): void {
  const record = expectExactRecord(value, "projected revision heads", [
    "document_id",
    "head_revision_ids",
    "adoptions"
  ]);
  parseEntityId("document", record.document_id);
  validateSortedIds(record.head_revision_ids, "document-revision", "revision heads");
  validateSortedRecords(record.adoptions, "revision adoptions", "revision_id", (candidate) => {
    const adoption = expectExactRecord(candidate, "revision adoption", [
      "revision_id",
      "adopting_event_ids",
      "adopting_payload_ids",
      "author_device_ids",
      "author_roles",
      "attestation_ids",
      "adoption_kinds",
      "is_head",
      "superseded_by_revision_ids"
    ]);
    parseDigestId("document-revision", adoption.revision_id);
    validateSortedIds(adoption.adopting_event_ids, "semantic-event", "adoption events");
    validateSortedIds(adoption.adopting_payload_ids, "semantic-payload", "adoption payloads");
    validateSortedIds(adoption.author_device_ids, "device", "adoption devices");
    validateSortedStrings(adoption.author_roles, "adoption roles");
    validateSortedIds(adoption.attestation_ids, "attestation", "adoption attestations");
    validateSortedStrings(adoption.adoption_kinds, "adoption kinds");
    expectLiteral(typeof adoption.is_head === "boolean", true, "adoption head marker");
    validateSortedIds(adoption.superseded_by_revision_ids, "document-revision", "superseding revisions");
  });
}

function validateRejection(value: unknown): void {
  const record = expectExactRecord(value, "projection rejection", [
    "rejection_version",
    "event_id",
    "payload_id",
    "reason",
    "detail"
  ]);
  expectLiteral(record.rejection_version, 1, "projection rejection version");
  parseDigestId("semantic-event", record.event_id);
  parseDigestId("semantic-payload", record.payload_id);
  expectEnum(record.reason, [
    "missing_subject",
    "duplicate_identity",
    "invalid_transition",
    "permanently_deleted",
    "unobserved_conflict",
    "unauthorized_revision_adoption",
    "invalid_revision",
    "unsupported_payload"
  ] as const, "projection rejection reason");
  expectString(record.detail, "projection rejection detail");
}

function validateEventProvenance(value: unknown): void {
  const record = expectExactRecord(value, "projected event provenance", [
    "event_id",
    "payload_id",
    "author_device_id",
    "author_role",
    "author_attestation_ids",
    "control_head_id"
  ]);
  parseDigestId("semantic-event", record.event_id);
  parseDigestId("semantic-payload", record.payload_id);
  parseEntityId("device", record.author_device_id);
  expectEnum(record.author_role, ["owner", "editor", "reviewer"] as const, "event author role");
  validateSortedIds(record.author_attestation_ids, "attestation", "event attestations");
  parseDigestId("control-event", record.control_head_id);
}

function validateRegister(value: unknown, label: string): void {
  const record = expectExactRecord(value, `${label} register`, [
    "register_version",
    "state",
    "resolved_value",
    "last_uncontested_value",
    "contenders"
  ]);
  expectLiteral(record.register_version, 1, `${label} register version`);
  expectEnum(record.state, ["unset", "resolved", "conflicted"] as const, `${label} register state`);
  if (record.resolved_value !== null) expectString(record.resolved_value, `${label} resolved value`);
  if (record.last_uncontested_value !== null) expectString(record.last_uncontested_value, `${label} last value`);
  validateSortedRecords(record.contenders, `${label} contenders`, "value", (candidate) => {
    const contender = expectExactRecord(candidate, `${label} contender`, [
      "value",
      "value_commitment",
      "event_ids",
      "payload_ids"
    ]);
    expectString(contender.value, `${label} contender value`);
    const commitment = expectString(contender.value_commitment, `${label} value commitment`);
    if (!/^sha256:[0-9a-f]{64}$/.test(commitment)) throw new Error(`${label} has an invalid value commitment.`);
    validateSortedIds(contender.event_ids, "semantic-event", `${label} contender events`);
    validateSortedIds(contender.payload_ids, "semantic-payload", `${label} contender payloads`);
  });
}

function validateTombstone(value: unknown, label: string): void {
  if (value === null) return;
  const record = expectExactRecord(value, label, [
    "tombstone_version",
    "deletion_event_ids",
    "deletion_payload_ids",
    "contender_event_ids"
  ]);
  expectLiteral(record.tombstone_version, 1, `${label} version`);
  validateSortedIds(record.deletion_event_ids, "semantic-event", `${label} deletion events`);
  validateSortedIds(record.deletion_payload_ids, "semantic-payload", `${label} deletion payloads`);
  validateSortedIds(record.contender_event_ids, "semantic-event", `${label} contenders`);
}

function validateSortedRecords(
  value: unknown,
  label: string,
  key: string,
  validate: (candidate: unknown) => void
): void {
  const records = expectArray(value, label);
  const keys: string[] = [];
  for (const candidate of records) {
    validate(candidate);
    const record = expectExactRecord(candidate, label, [key], Object.keys(candidate as object).filter((candidateKey) => candidateKey !== key));
    keys.push(expectString(record[key], `${label} sort key`));
  }
  assertStrictlySorted(keys, label);
}

function validateSortedIds(
  value: unknown,
  kind: Parameters<typeof parseEntityId>[0] | Parameters<typeof parseDigestId>[0],
  label: string
): void {
  const values = expectArray(value, label).map((candidate) => {
    try {
      return parseEntityId(kind as Parameters<typeof parseEntityId>[0], candidate);
    } catch {
      return parseDigestId(kind as Parameters<typeof parseDigestId>[0], candidate);
    }
  });
  assertStrictlySorted(values, label);
}

function validateUniqueIds(
  value: unknown,
  kind: Parameters<typeof parseEntityId>[0] | Parameters<typeof parseDigestId>[0],
  label: string
): void {
  const values = expectArray(value, label).map((candidate) => {
    try {
      return parseEntityId(kind as Parameters<typeof parseEntityId>[0], candidate);
    } catch {
      return parseDigestId(kind as Parameters<typeof parseDigestId>[0], candidate);
    }
  });
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique IDs.`);
  }
}

function validateSortedStrings(value: unknown, label: string): void {
  const values = expectArray(value, label).map((candidate) => expectString(candidate, label));
  assertStrictlySorted(values, label);
}

function assertStrictlySorted(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  }
}

import {
  IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
  LEGACY_IDENTITY_ALIAS_SCHEMA_VERSION,
  TRUSTED_IDENTITY_ADOPTION_SCHEMA_VERSION
} from "./versions.ts";
import {
  type CommentId,
  type DocumentId,
  type DocumentRevisionId,
  type GroupId,
  type ImportId,
  type PatchGroupId,
  type PatchId,
  type ProjectId,
  type ReplyId,
  type ReviewBatchId,
  type RewriteReviewId,
  type RewriteSessionId,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  expectArray,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectNonEmptyString,
  freezeRecord
} from "./validation.ts";

export const existingIdentityKinds = [
  "project",
  "document",
  "group",
  "review-batch",
  "comment",
  "reply",
  "patch",
  "patch-group",
  "import",
  "snapshot",
  "rewrite-session",
  "rewrite-review"
] as const;

export const preservableExistingIdentityKinds = [
  "project",
  "document",
  "group",
  "review-batch",
  "rewrite-session",
  "rewrite-review"
] as const;

export const preservedExistingIdentityFormats = [
  "project_uuid_v4",
  "document_uuid_v4",
  "group_uuid_v4",
  "review_batch_uuid_v4",
  "rewrite_session_uuid_v4",
  "rewrite_review_uuid_v4"
] as const;

export const identityReplacementReasons = [
  "missing",
  "malformed",
  "document_local_sequence",
  "comment_local_sequence",
  "timestamp_derived",
  "collision_prone_derived",
  "duplicate_in_migration_scope"
] as const;

export type ExistingIdentityKind = (typeof existingIdentityKinds)[number];
export type PreservableExistingIdentityKind =
  (typeof preservableExistingIdentityKinds)[number];
export type PreservedExistingIdentityFormat =
  (typeof preservedExistingIdentityFormats)[number];
export type IdentityReplacementReason =
  (typeof identityReplacementReasons)[number];

export type ExistingAuthoritativeIdByKind = {
  project: ProjectId;
  document: DocumentId;
  group: GroupId;
  "review-batch": ReviewBatchId;
  comment: CommentId;
  reply: ReplyId;
  patch: PatchId;
  "patch-group": PatchGroupId;
  import: ImportId;
  snapshot: DocumentRevisionId;
  "rewrite-session": RewriteSessionId;
  "rewrite-review": RewriteReviewId;
};

export type ExistingIdentityClassification =
  | Readonly<{
      disposition: "preserve_candidate";
      identity_kind: PreservableExistingIdentityKind;
      existing_id: string;
      source_format: PreservedExistingIdentityFormat;
      collision_verification: "required_before_activation";
    }>
  | Readonly<{
      disposition: "replace_and_alias";
      identity_kind: ExistingIdentityKind;
      existing_id: string | null;
      replacement_reason: IdentityReplacementReason;
    }>;

export type TrustedIdentityCollisionVerification = Readonly<{
  requirement: "project_wide_exact_identity_uniqueness";
  status: "verified_unique";
  migration_scope_id: string;
}>;

export type TrustedIdentityAdoptionInput<
  TKind extends PreservableExistingIdentityKind =
    PreservableExistingIdentityKind
> = Readonly<{
  schema_version: typeof TRUSTED_IDENTITY_ADOPTION_SCHEMA_VERSION;
  object_kind: "trusted_identity_adoption_input";
  source: "trusted_local_project_migration";
  identity_kind: TKind;
  existing_id: string;
  source_format: PreservedExistingIdentityFormat;
  collision_verification: TrustedIdentityCollisionVerification;
}>;

export type TrustedIdentityAdoption<
  TKind extends PreservableExistingIdentityKind =
    PreservableExistingIdentityKind
> = Readonly<{
  schema_version: typeof TRUSTED_IDENTITY_ADOPTION_SCHEMA_VERSION;
  object_kind: "trusted_identity_adoption";
  identity_kind: TKind;
  source_format: PreservedExistingIdentityFormat;
  authoritative_id: ExistingAuthoritativeIdByKind[TKind];
  collision_verification: TrustedIdentityCollisionVerification;
}>;

export type ProjectLegacyAliasScope = Readonly<{
  scope_kind: "project";
  project_legacy_id: string;
}>;

export type DocumentLegacyAliasScope = Readonly<{
  scope_kind: "document";
  project_legacy_id: string;
  document_legacy_id: string;
}>;

export type CommentLegacyAliasScope = Readonly<{
  scope_kind: "comment";
  project_legacy_id: string;
  document_legacy_id: string;
  comment_legacy_id: string;
}>;

export type LegacyIdentityAliasScope =
  | ProjectLegacyAliasScope
  | DocumentLegacyAliasScope
  | CommentLegacyAliasScope;

export type LegacyIdentityAlias = Readonly<{
  schema_version: typeof LEGACY_IDENTITY_ALIAS_SCHEMA_VERSION;
  alias_kind: "legacy_identity";
  authority: "none";
  identity_kind: ExistingIdentityKind;
  legacy_id: string;
  scope: LegacyIdentityAliasScope;
}>;

export type PreservedIdentityMigrationDecision = Readonly<{
  decision: "preserve_exact_authoritative";
  adoption: TrustedIdentityAdoption;
}>;

export type ReplacementIdentityMigrationDecision = Readonly<{
  decision: "replace_and_alias";
  identity_kind: ExistingIdentityKind;
  previous_id: string | null;
  replacement_reason: IdentityReplacementReason;
  authoritative_id: ExistingAuthoritativeIdByKind[ExistingIdentityKind];
  legacy_alias: LegacyIdentityAlias | null;
}>;

export type IdentityMigrationDecision =
  | PreservedIdentityMigrationDecision
  | ReplacementIdentityMigrationDecision;

export type IdentityMigrationPlan = Readonly<{
  schema_version: typeof IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION;
  object_kind: "identity_migration_plan";
  migration_scope_id: string;
  collision_policy: "project_wide_exact_identity_uniqueness_required";
  entries: readonly IdentityMigrationDecision[];
}>;

const uuidV4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const preservedPatterns: Readonly<
  Record<
    PreservableExistingIdentityKind,
    Readonly<{ format: PreservedExistingIdentityFormat; pattern: RegExp }>
  >
> = Object.freeze({
  project: Object.freeze({
    format: "project_uuid_v4",
    pattern: new RegExp(`^prj_${uuidV4}$`)
  }),
  document: Object.freeze({
    format: "document_uuid_v4",
    pattern: new RegExp(`^doc_${uuidV4}$`)
  }),
  group: Object.freeze({
    format: "group_uuid_v4",
    pattern: new RegExp(`^grp_${uuidV4}$`)
  }),
  "review-batch": Object.freeze({
    format: "review_batch_uuid_v4",
    pattern: new RegExp(`^review_batch_${uuidV4}$`)
  }),
  "rewrite-session": Object.freeze({
    format: "rewrite_session_uuid_v4",
    pattern: new RegExp(`^rewrite_session_${uuidV4}$`)
  }),
  "rewrite-review": Object.freeze({
    format: "rewrite_review_uuid_v4",
    pattern: new RegExp(`^rewrite_review_${uuidV4}$`)
  })
});

const sequentialPatterns: Partial<Record<ExistingIdentityKind, RegExp>> = {
  comment: /^PM-COMMENT-\d+$/,
  reply: /^PM-THREAD-\d+$/,
  patch: /^PM-PATCH-\d+$/,
  "patch-group": /^PM-PATCH-GROUP-\d+$/
};

const timestampPatterns: Partial<Record<ExistingIdentityKind, RegExp>> = {
  project: /^prj_[a-z0-9]+-[a-z0-9]+$/,
  document: /^doc_[a-z0-9]+-[a-z0-9]+$/,
  group: /^grp_[a-z0-9]+-[a-z0-9]+$/,
  import: /^PM-IMPORT-\d{8}-\d{6}-\d{3}$/,
  snapshot: /^snapshot-\d{8}-\d{6}-\d{3}$/,
  "rewrite-session": /^rewrite_session_[a-z0-9]+-[a-z0-9]+$/,
  "rewrite-review": /^rewrite_review_[a-z0-9]+-[a-z0-9]+$/
};

const expectedAliasScope: Readonly<
  Record<ExistingIdentityKind, LegacyIdentityAliasScope["scope_kind"]>
> = Object.freeze({
  project: "project",
  document: "project",
  group: "project",
  "review-batch": "document",
  comment: "document",
  reply: "comment",
  patch: "document",
  "patch-group": "document",
  import: "document",
  snapshot: "document",
  "rewrite-session": "document",
  "rewrite-review": "document"
});

export function classifyExistingIdentity(
  identityKind: ExistingIdentityKind,
  value: unknown
): ExistingIdentityClassification {
  const kind = expectEnum(
    identityKind,
    existingIdentityKinds,
    "existing identity kind"
  );
  if (value === null || value === undefined || value === "") {
    return freezeRecord({
      disposition: "replace_and_alias" as const,
      identity_kind: kind,
      existing_id: null,
      replacement_reason: "missing" as const
    });
  }
  if (typeof value !== "string") {
    return replacementClassification(kind, null, "malformed");
  }

  if (isPreservableKind(kind)) {
    const preserved = preservedPatterns[kind];
    if (preserved.pattern.test(value)) {
      return freezeRecord({
        disposition: "preserve_candidate" as const,
        identity_kind: kind,
        existing_id: value,
        source_format: preserved.format,
        collision_verification: "required_before_activation" as const
      });
    }
  }

  if (sequentialPatterns[kind]?.test(value)) {
    return replacementClassification(
      kind,
      value,
      kind === "reply"
        ? "comment_local_sequence"
        : "document_local_sequence"
    );
  }
  if (timestampPatterns[kind]?.test(value)) {
    return replacementClassification(kind, value, "timestamp_derived");
  }
  if (kind === "project" && /^prj_legacy_[0-9a-f]{8}$/.test(value)) {
    return replacementClassification(kind, value, "collision_prone_derived");
  }
  return replacementClassification(kind, value, "malformed");
}

/**
 * Trusted local migration boundary only. Protocol input must not invoke this
 * function: the caller is responsible for completing the encoded project-wide
 * collision check before the exact existing text gains an authoritative brand.
 */
export function adoptTrustedExistingIdentity<
  TKind extends PreservableExistingIdentityKind
>(value: TrustedIdentityAdoptionInput<TKind> | unknown): TrustedIdentityAdoption<TKind> {
  const record = expectExactRecord(value, "trusted identity adoption input", [
    "schema_version",
    "object_kind",
    "source",
    "identity_kind",
    "existing_id",
    "source_format",
    "collision_verification"
  ]);
  expectLiteral(
    record.schema_version,
    TRUSTED_IDENTITY_ADOPTION_SCHEMA_VERSION,
    "trusted identity adoption schema version"
  );
  expectLiteral(
    record.object_kind,
    "trusted_identity_adoption_input",
    "trusted identity adoption object kind"
  );
  expectLiteral(
    record.source,
    "trusted_local_project_migration",
    "trusted identity adoption source"
  );
  const kind = expectEnum(
    record.identity_kind,
    preservableExistingIdentityKinds,
    "preservable existing identity kind"
  ) as TKind;
  const existingId = expectNonEmptyString(record.existing_id, "existing identity");
  const sourceFormat = expectEnum(
    record.source_format,
    preservedExistingIdentityFormats,
    "preserved existing identity format"
  );
  const collisionVerification = parseCollisionVerification(
    record.collision_verification
  );
  const classification = classifyExistingIdentity(kind, existingId);
  if (
    classification.disposition !== "preserve_candidate" ||
    classification.source_format !== sourceFormat
  ) {
    throw new Error(
      `${kind} identity does not match the claimed collision-resistant format.`
    );
  }
  return freezeRecord({
    schema_version: TRUSTED_IDENTITY_ADOPTION_SCHEMA_VERSION,
    object_kind: "trusted_identity_adoption" as const,
    identity_kind: kind,
    source_format: sourceFormat,
    authoritative_id:
      existingId as ExistingAuthoritativeIdByKind[TKind],
    collision_verification: collisionVerification
  });
}

export function parseTrustedIdentityAdoption(
  value: unknown
): TrustedIdentityAdoption {
  const record = expectExactRecord(value, "trusted identity adoption", [
    "schema_version",
    "object_kind",
    "identity_kind",
    "source_format",
    "authoritative_id",
    "collision_verification"
  ]);
  const input = {
    schema_version: record.schema_version,
    object_kind: "trusted_identity_adoption_input" as const,
    source: "trusted_local_project_migration" as const,
    identity_kind: record.identity_kind,
    existing_id: record.authoritative_id,
    source_format: record.source_format,
    collision_verification: record.collision_verification
  };
  expectLiteral(
    record.object_kind,
    "trusted_identity_adoption",
    "trusted identity adoption object kind"
  );
  return adoptTrustedExistingIdentity(input);
}

export function adaptLegacyIdentity({
  identityKind,
  legacyId,
  scope
}: {
  identityKind: ExistingIdentityKind;
  legacyId: string;
  scope: LegacyIdentityAliasScope;
}): LegacyIdentityAlias {
  const kind = expectEnum(
    identityKind,
    existingIdentityKinds,
    "legacy identity kind"
  );
  const parsedScope = parseLegacyIdentityAliasScope(scope);
  if (parsedScope.scope_kind !== expectedAliasScope[kind]) {
    throw new Error(
      `${kind} legacy identity requires ${expectedAliasScope[kind]} scope.`
    );
  }
  return freezeRecord({
    schema_version: LEGACY_IDENTITY_ALIAS_SCHEMA_VERSION,
    alias_kind: "legacy_identity" as const,
    authority: "none" as const,
    identity_kind: kind,
    legacy_id: expectNonEmptyString(legacyId, "legacy identity"),
    scope: parsedScope
  });
}

export function parseLegacyIdentityAlias(value: unknown): LegacyIdentityAlias {
  const record = expectExactRecord(value, "legacy identity alias", [
    "schema_version",
    "alias_kind",
    "authority",
    "identity_kind",
    "legacy_id",
    "scope"
  ]);
  expectLiteral(
    record.schema_version,
    LEGACY_IDENTITY_ALIAS_SCHEMA_VERSION,
    "legacy identity alias schema version"
  );
  expectLiteral(
    record.alias_kind,
    "legacy_identity",
    "legacy identity alias kind"
  );
  expectLiteral(record.authority, "none", "legacy identity alias authority");
  return adaptLegacyIdentity({
    identityKind: expectEnum(
      record.identity_kind,
      existingIdentityKinds,
      "legacy identity kind"
    ),
    legacyId: expectNonEmptyString(record.legacy_id, "legacy identity"),
    scope: parseLegacyIdentityAliasScope(record.scope)
  });
}

export function parseIdentityMigrationPlan(
  value: unknown
): IdentityMigrationPlan {
  const record = expectExactRecord(value, "identity migration plan", [
    "schema_version",
    "object_kind",
    "migration_scope_id",
    "collision_policy",
    "entries"
  ]);
  expectLiteral(
    record.schema_version,
    IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
    "identity migration plan schema version"
  );
  expectLiteral(
    record.object_kind,
    "identity_migration_plan",
    "identity migration plan object kind"
  );
  expectLiteral(
    record.collision_policy,
    "project_wide_exact_identity_uniqueness_required",
    "identity migration collision policy"
  );
  const migrationScopeId = expectNonEmptyString(
    record.migration_scope_id,
    "identity migration scope"
  );
  const entries = expectArray(record.entries, "identity migration entries").map(
    (entry, index) => parseMigrationDecision(entry, index, migrationScopeId)
  );
  const keys = entries.map(migrationDecisionKey);
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] >= keys[index]) {
      throw new Error(
        "Identity migration entries must be strictly sorted and unique by kind and authoritative ID."
      );
    }
  }
  return freezeRecord({
    schema_version: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
    object_kind: "identity_migration_plan" as const,
    migration_scope_id: migrationScopeId,
    collision_policy:
      "project_wide_exact_identity_uniqueness_required" as const,
    entries: Object.freeze(entries)
  });
}

function parseMigrationDecision(
  value: unknown,
  index: number,
  migrationScopeId: string
): IdentityMigrationDecision {
  const discriminator = expectExactRecord(
    value,
    `identity migration entry ${index + 1}`,
    ["decision"],
    [
      "adoption",
      "identity_kind",
      "previous_id",
      "replacement_reason",
      "authoritative_id",
      "legacy_alias"
    ]
  );
  const decision = expectEnum(
    discriminator.decision,
    ["preserve_exact_authoritative", "replace_and_alias"] as const,
    "identity migration decision"
  );
  if (decision === "preserve_exact_authoritative") {
    expectExactRecord(value, `identity migration entry ${index + 1}`, [
      "decision",
      "adoption"
    ]);
    const adoption = parseTrustedIdentityAdoption(discriminator.adoption);
    if (
      adoption.collision_verification.migration_scope_id !== migrationScopeId
    ) {
      throw new Error("Identity adoption collision scope must match its plan.");
    }
    return freezeRecord({
      decision: "preserve_exact_authoritative" as const,
      adoption
    });
  }

  expectExactRecord(value, `identity migration entry ${index + 1}`, [
    "decision",
    "identity_kind",
    "previous_id",
    "replacement_reason",
    "authoritative_id",
    "legacy_alias"
  ]);
  const kind = expectEnum(
    discriminator.identity_kind,
    existingIdentityKinds,
    "replacement identity kind"
  );
  const previousId =
    discriminator.previous_id === null
      ? null
      : expectNonEmptyString(discriminator.previous_id, "previous identity");
  const replacementReason = expectEnum(
    discriminator.replacement_reason,
    identityReplacementReasons,
    "identity replacement reason"
  );
  const authoritativeId = parseReplacementAuthoritativeId(
    kind,
    discriminator.authoritative_id
  );
  const alias =
    discriminator.legacy_alias === null
      ? null
      : parseLegacyIdentityAlias(discriminator.legacy_alias);
  assertReplacementDecision({
    alias,
    authoritativeId,
    kind,
    migrationScopeId,
    previousId,
    replacementReason
  });
  return freezeRecord({
    decision: "replace_and_alias" as const,
    identity_kind: kind,
    previous_id: previousId,
    replacement_reason: replacementReason,
    authoritative_id: authoritativeId,
    legacy_alias: alias
  });
}

function assertReplacementDecision({
  alias,
  authoritativeId,
  kind,
  migrationScopeId,
  previousId,
  replacementReason
}: {
  alias: LegacyIdentityAlias | null;
  authoritativeId: string;
  kind: ExistingIdentityKind;
  migrationScopeId: string;
  previousId: string | null;
  replacementReason: IdentityReplacementReason;
}): void {
  if (previousId === null) {
    if (replacementReason !== "missing" || alias !== null) {
      throw new Error("A missing identity must be replaced without an alias.");
    }
    return;
  }
  if (
    alias === null ||
    alias.identity_kind !== kind ||
    alias.legacy_id !== previousId
  ) {
    throw new Error("A replaced existing identity requires its exact scoped alias.");
  }
  if (alias.scope.project_legacy_id !== migrationScopeId) {
    throw new Error("Legacy alias project scope must match its migration plan.");
  }
  if (previousId === authoritativeId) {
    throw new Error("A legacy alias cannot equal its authoritative replacement.");
  }
  const classification = classifyExistingIdentity(kind, previousId);
  if (
    replacementReason !== "duplicate_in_migration_scope" &&
    (classification.disposition !== "replace_and_alias" ||
      classification.replacement_reason !== replacementReason)
  ) {
    throw new Error("Identity replacement reason does not match its format.");
  }
}

function parseReplacementAuthoritativeId(
  kind: ExistingIdentityKind,
  value: unknown
): ExistingAuthoritativeIdByKind[ExistingIdentityKind] {
  switch (kind) {
    case "project":
      return parseEntityId("project", value);
    case "document":
      return parseEntityId("document", value);
    case "group":
      return parseEntityId("group", value);
    case "review-batch":
      return parseEntityId("review-batch", value);
    case "comment":
      return parseEntityId("comment", value);
    case "reply":
      return parseEntityId("reply", value);
    case "patch":
      return parseEntityId("patch", value);
    case "patch-group":
      return parseEntityId("patch-group", value);
    case "import":
      return parseEntityId("import", value);
    case "snapshot":
      // Existing timestamp snapshot IDs are document-local revision aliases.
      // Their authoritative replacement is the digest-derived revision identity.
      return parseDigestId("document-revision", value);
    case "rewrite-session":
      return parseEntityId("rewrite-session", value);
    case "rewrite-review":
      return parseEntityId("rewrite-review", value);
  }
}

function parseLegacyIdentityAliasScope(
  value: unknown
): LegacyIdentityAliasScope {
  const discriminator = expectExactRecord(
    value,
    "legacy identity alias scope",
    ["scope_kind", "project_legacy_id"],
    ["document_legacy_id", "comment_legacy_id"]
  );
  const scopeKind = expectEnum(
    discriminator.scope_kind,
    ["project", "document", "comment"] as const,
    "legacy identity alias scope kind"
  );
  const projectLegacyId = expectNonEmptyString(
    discriminator.project_legacy_id,
    "legacy project scope"
  );
  if (scopeKind === "project") {
    expectExactRecord(value, "project legacy identity alias scope", [
      "scope_kind",
      "project_legacy_id"
    ]);
    return freezeRecord({
      scope_kind: "project" as const,
      project_legacy_id: projectLegacyId
    });
  }
  const documentLegacyId = expectNonEmptyString(
    discriminator.document_legacy_id,
    "legacy document scope"
  );
  if (scopeKind === "document") {
    expectExactRecord(value, "document legacy identity alias scope", [
      "scope_kind",
      "project_legacy_id",
      "document_legacy_id"
    ]);
    return freezeRecord({
      scope_kind: "document" as const,
      project_legacy_id: projectLegacyId,
      document_legacy_id: documentLegacyId
    });
  }
  expectExactRecord(value, "comment legacy identity alias scope", [
    "scope_kind",
    "project_legacy_id",
    "document_legacy_id",
    "comment_legacy_id"
  ]);
  return freezeRecord({
    scope_kind: "comment" as const,
    project_legacy_id: projectLegacyId,
    document_legacy_id: documentLegacyId,
    comment_legacy_id: expectNonEmptyString(
      discriminator.comment_legacy_id,
      "legacy comment scope"
    )
  });
}

function parseCollisionVerification(
  value: unknown
): TrustedIdentityCollisionVerification {
  const record = expectExactRecord(value, "identity collision verification", [
    "requirement",
    "status",
    "migration_scope_id"
  ]);
  return freezeRecord({
    requirement: expectLiteral(
      record.requirement,
      "project_wide_exact_identity_uniqueness",
      "identity collision verification requirement"
    ),
    status: expectLiteral(
      record.status,
      "verified_unique",
      "identity collision verification status"
    ),
    migration_scope_id: expectNonEmptyString(
      record.migration_scope_id,
      "identity collision migration scope"
    )
  });
}

function replacementClassification(
  kind: ExistingIdentityKind,
  existingId: string | null,
  replacementReason: IdentityReplacementReason
): ExistingIdentityClassification {
  return freezeRecord({
    disposition: "replace_and_alias" as const,
    identity_kind: kind,
    existing_id: existingId,
    replacement_reason: replacementReason
  });
}

function isPreservableKind(
  kind: ExistingIdentityKind
): kind is PreservableExistingIdentityKind {
  return preservableExistingIdentityKinds.includes(
    kind as PreservableExistingIdentityKind
  );
}

function migrationDecisionKey(decision: IdentityMigrationDecision): string {
  return decision.decision === "preserve_exact_authoritative"
    ? `${decision.adoption.identity_kind}\u0000${decision.adoption.authoritative_id}`
    : `${decision.identity_kind}\u0000${decision.authoritative_id}`;
}

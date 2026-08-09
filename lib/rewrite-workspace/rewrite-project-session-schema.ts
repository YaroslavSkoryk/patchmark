import type { ProjectDocumentIdentity } from "../project/document-scoped-identity.ts";
import { validateRewriteReviewResponseValue } from "./rewrite-review-schema.ts";
import type {
  RewriteProjectSessionRecord,
  RewriteProjectSessionStore,
  RewriteReviewRound,
  RewriteSemanticReviewResponse,
  RewriteSession,
  RewriteTarget,
  RewriteTerminalSession
} from "./rewrite-session-types.ts";

export const REWRITE_PROJECT_SESSION_SCHEMA_VERSION = 1;

export function createEmptyRewriteProjectSessionStore(
  identity: ProjectDocumentIdentity
): RewriteProjectSessionStore {
  return {
    schema_version: REWRITE_PROJECT_SESSION_SCHEMA_VERSION,
    project_id: identity.projectId,
    document_id: identity.documentId,
    sessions: []
  };
}

export function parseRewriteProjectSessionStore({
  identity,
  text
}: {
  identity: ProjectDocumentIdentity;
  text: string;
}): RewriteProjectSessionStore {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(".patchmark/rewrite-sessions.json contains malformed JSON.");
  }
  if (
    !isRecord(value) ||
    value.schema_version !== REWRITE_PROJECT_SESSION_SCHEMA_VERSION ||
    value.project_id !== identity.projectId ||
    value.document_id !== identity.documentId ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error(".patchmark/rewrite-sessions.json has invalid document ownership or schema.");
  }
  const sessions = value.sessions.map((candidate, index) =>
    normalizeRewriteProjectSession(candidate, identity, index)
  );
  assertRewriteProjectSessionCollection(sessions, identity);
  return {
    schema_version: REWRITE_PROJECT_SESSION_SCHEMA_VERSION,
    project_id: identity.projectId,
    document_id: identity.documentId,
    sessions
  };
}

export function serializeRewriteProjectSessionStore({
  identity,
  sessions
}: {
  identity: ProjectDocumentIdentity;
  sessions: RewriteProjectSessionRecord[];
}): string {
  const normalizedSessions = sessions.map((session, index) =>
    normalizeRewriteProjectSession(session, identity, index)
  );
  assertRewriteProjectSessionCollection(normalizedSessions, identity);
  return `${JSON.stringify(
    {
      schema_version: REWRITE_PROJECT_SESSION_SCHEMA_VERSION,
      project_id: identity.projectId,
      document_id: identity.documentId,
      sessions: normalizedSessions
    },
    null,
    2
  )}\n`;
}

export function assertRewriteProjectSessionCollection(
  sessions: RewriteProjectSessionRecord[],
  identity: ProjectDocumentIdentity
): void {
  const ids = new Set<string>();
  let activeCount = 0;
  sessions.forEach((session, index) => {
    const normalized = normalizeRewriteProjectSession(session, identity, index);
    if (ids.has(normalized.rewrite_session_id)) {
      throw new Error(
        `Duplicate Human Rewrite session ID in ${identity.documentId}: ${normalized.rewrite_session_id}.`
      );
    }
    ids.add(normalized.rewrite_session_id);
    if (normalized.status === "draft") {
      activeCount += 1;
    }
  });
  if (activeCount > 1) {
    throw new Error("A document may have at most one active Human Rewrite session.");
  }
}

function normalizeRewriteProjectSession(
  value: unknown,
  identity: ProjectDocumentIdentity,
  index: number
): RewriteProjectSessionRecord {
  if (!isRecord(value) || value.project_id !== identity.projectId || value.document_id !== identity.documentId) {
    throw invalidSession(index);
  }
  if (value.status === "applied" || value.status === "discarded") {
    return normalizeTerminalSession(value, index);
  }
  return normalizeActiveSession(value, index);
}

function normalizeActiveSession(
  value: Record<string, unknown>,
  index: number
): RewriteSession {
  if (
    value.schema_version !== 1 ||
    value.status !== "draft" ||
    !isNonEmptyString(value.rewrite_session_id) ||
    !isNonEmptyString(value.local_project_instance_id) ||
    !isNonEmptyString(value.project_id) ||
    !isNonEmptyString(value.document_id) ||
    typeof value.project_title_snapshot !== "string" ||
    typeof value.document_title_snapshot !== "string" ||
    !isNonNegativeInteger(value.base_document_generation) ||
    !isHash(value.base_document_sha256) ||
    !isHash(value.base_text_sha256) ||
    typeof value.base_text !== "string" ||
    !isHash(value.human_draft_sha256) ||
    typeof value.human_draft !== "string" ||
    typeof value.intent_note !== "string" ||
    !isNonNegativeInteger(value.authoritative_revision) ||
    !isNonNegativeInteger(value.authoritative_generation) ||
    typeof value.stale_reference !== "boolean" ||
    !isDateString(value.created_at) ||
    !isDateString(value.updated_at) ||
    !Array.isArray(value.review_rounds) ||
    !Array.isArray(value.reference_history)
  ) {
    throw invalidSession(index);
  }
  const projectId = value.project_id;
  const documentId = value.document_id;
  const reviewRounds = value.review_rounds.map((round, roundIndex) =>
    normalizeReviewRound(
      round,
      index,
      roundIndex,
      projectId,
      documentId
    )
  );
  if (
    reviewRounds.filter((round) => round.status === "awaiting_response").length > 1
  ) {
    throw new Error(`Human Rewrite session ${index + 1} has multiple active review requests.`);
  }
  return {
    schema_version: 1,
    rewrite_session_id: value.rewrite_session_id,
    local_project_instance_id: value.local_project_instance_id,
    project_id: projectId,
    document_id: documentId,
    project_title_snapshot: value.project_title_snapshot,
    document_title_snapshot: value.document_title_snapshot,
    target: normalizeTarget(value.target, index),
    base_document_generation: value.base_document_generation,
    base_document_sha256: value.base_document_sha256,
    base_text_sha256: value.base_text_sha256,
    base_text: value.base_text,
    human_draft_sha256: value.human_draft_sha256,
    human_draft: value.human_draft,
    intent_note: value.intent_note,
    status: "draft",
    authoritative_revision: value.authoritative_revision,
    authoritative_generation: value.authoritative_generation,
    stale_reference: value.stale_reference,
    created_at: value.created_at,
    updated_at: value.updated_at,
    review_rounds: reviewRounds,
    reference_history: value.reference_history.map((entry) => {
      if (
        !isRecord(entry) ||
        !isNonNegativeInteger(entry.base_document_generation) ||
        !isHash(entry.base_document_sha256) ||
        !isHash(entry.base_text_sha256) ||
        typeof entry.base_text !== "string" ||
        !isDateString(entry.refreshed_at)
      ) {
        throw invalidSession(index);
      }
      return {
        base_document_generation: entry.base_document_generation,
        base_document_sha256: entry.base_document_sha256,
        base_text_sha256: entry.base_text_sha256,
        base_text: entry.base_text,
        refreshed_at: entry.refreshed_at
      };
    })
  };
}

function normalizeTerminalSession(
  value: Record<string, unknown>,
  index: number
): RewriteTerminalSession {
  if (
    value.schema_version !== 1 ||
    (value.status !== "applied" && value.status !== "discarded") ||
    !isNonEmptyString(value.rewrite_session_id) ||
    !isNonEmptyString(value.local_project_instance_id) ||
    !isNonEmptyString(value.project_id) ||
    !isNonEmptyString(value.document_id) ||
    !isNonNegativeInteger(value.authoritative_revision) ||
    !isNonNegativeInteger(value.authoritative_generation) ||
    !isHash(value.human_draft_sha256) ||
    !isDateString(value.updated_at)
  ) {
    throw invalidSession(index);
  }
  if (
    value.status === "applied" && !isDateString(value.applied_at) ||
    value.status === "discarded" && !isDateString(value.discarded_at)
  ) {
    throw invalidSession(index);
  }
  return {
    schema_version: 1,
    rewrite_session_id: value.rewrite_session_id,
    local_project_instance_id: value.local_project_instance_id,
    project_id: value.project_id,
    document_id: value.document_id,
    status: value.status,
    authoritative_revision: value.authoritative_revision,
    authoritative_generation: value.authoritative_generation,
    human_draft_sha256: value.human_draft_sha256,
    updated_at: value.updated_at,
    ...(value.status === "applied" ? { applied_at: value.applied_at as string } : {}),
    ...(value.status === "discarded" ? { discarded_at: value.discarded_at as string } : {}),
    ...(typeof value.version_id === "string" ? { version_id: value.version_id } : {})
  };
}

function normalizeTarget(value: unknown, index: number): RewriteTarget {
  if (
    !isRecord(value) ||
    (value.kind !== "selection" && value.kind !== "section") ||
    (value.heading_snapshot !== null && typeof value.heading_snapshot !== "string") ||
    (value.heading_level !== null && !isNonNegativeInteger(value.heading_level)) ||
    !Array.isArray(value.heading_path) ||
    !value.heading_path.every((item) => typeof item === "string") ||
    !isNonNegativeInteger(value.base_start) ||
    !isNonNegativeInteger(value.base_end) ||
    value.base_end <= value.base_start ||
    typeof value.context_before !== "string" ||
    typeof value.context_after !== "string"
  ) {
    throw invalidSession(index);
  }
  return {
    kind: value.kind,
    heading_snapshot: value.heading_snapshot,
    heading_level: value.heading_level,
    heading_path: value.heading_path,
    base_start: value.base_start,
    base_end: value.base_end,
    context_before: value.context_before,
    context_after: value.context_after
  };
}

function normalizeReviewRound(
  value: unknown,
  sessionIndex: number,
  roundIndex: number,
  projectId: string,
  documentId: string
): RewriteReviewRound {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.rewrite_review_id) ||
    !isHash(value.base_text_sha256) ||
    !isHash(value.human_draft_sha256) ||
    !isHash(value.intent_note_sha256) ||
    !isHash(value.prompt_sha256) ||
    typeof value.prompt_text !== "string" ||
    (value.prompt_byte_length !== undefined &&
      !isNonNegativeInteger(value.prompt_byte_length)) ||
    !isDateString(value.exported_at) ||
    (value.status !== "awaiting_response" &&
      value.status !== "cancelled" &&
      value.status !== "imported" &&
      value.status !== "superseded") ||
    (value.prompt_schema_version !== undefined &&
      !isNonNegativeInteger(value.prompt_schema_version)) ||
    (value.response_schema_fingerprint !== undefined &&
      !isSchemaFingerprint(value.response_schema_fingerprint)) ||
    (value.prompt_created_at !== undefined &&
      !isDateString(value.prompt_created_at)) ||
    (value.prompt_generator_version !== undefined &&
      !isNonEmptyString(value.prompt_generator_version)) ||
    (value.supersedes_review_request_id !== undefined &&
      !isNonEmptyString(value.supersedes_review_request_id)) ||
    (value.status === "superseded" &&
      (!isDateString(value.superseded_at) ||
        !isReviewSupersessionReason(value.superseded_reason) ||
        !isNonEmptyString(value.superseded_by_review_request_id)))
  ) {
    throw new Error(`Human Rewrite session ${sessionIndex + 1}, review round ${roundIndex + 1} is invalid.`);
  }
  const response = value.response === undefined
    ? undefined
    : normalizeSemanticResponse(value.response, sessionIndex, roundIndex);
  if (value.status === "imported" && !response) {
    throw invalidSession(sessionIndex);
  }
  return {
    rewrite_review_id: value.rewrite_review_id,
    request_project_id:
      typeof value.request_project_id === "string"
        ? value.request_project_id
        : projectId,
    request_document_id:
      typeof value.request_document_id === "string"
        ? value.request_document_id
        : documentId,
    base_text_sha256: value.base_text_sha256,
    human_draft_sha256: value.human_draft_sha256,
    intent_note_sha256: value.intent_note_sha256,
    prompt_sha256: value.prompt_sha256,
    prompt_text: value.prompt_text,
    ...(isNonNegativeInteger(value.prompt_byte_length)
      ? { prompt_byte_length: value.prompt_byte_length }
      : {}),
    exported_at: value.exported_at,
    ...(isNonNegativeInteger(value.prompt_schema_version)
      ? { prompt_schema_version: value.prompt_schema_version }
      : {}),
    ...(isSchemaFingerprint(value.response_schema_fingerprint)
      ? { response_schema_fingerprint: value.response_schema_fingerprint }
      : {}),
    ...(isDateString(value.prompt_created_at)
      ? { prompt_created_at: value.prompt_created_at }
      : {}),
    ...(isNonEmptyString(value.prompt_generator_version)
      ? { prompt_generator_version: value.prompt_generator_version }
      : {}),
    status: value.status,
    ...(isDateString(value.cancelled_at) ? { cancelled_at: value.cancelled_at } : {}),
    ...(isDateString(value.imported_at) ? { imported_at: value.imported_at } : {}),
    ...(isDateString(value.superseded_at) ? { superseded_at: value.superseded_at } : {}),
    ...(isReviewSupersessionReason(value.superseded_reason)
      ? { superseded_reason: value.superseded_reason }
      : {}),
    ...(isNonEmptyString(value.superseded_by_review_request_id)
      ? { superseded_by_review_request_id: value.superseded_by_review_request_id }
      : {}),
    ...(isNonEmptyString(value.supersedes_review_request_id)
      ? { supersedes_review_request_id: value.supersedes_review_request_id }
      : {}),
    ...(response ? { response } : {})
  };
}

function isReviewSupersessionReason(
  value: unknown
): value is NonNullable<RewriteReviewRound["superseded_reason"]> {
  return value === "prompt_regenerated" ||
    value === "outdated_prompt_format" ||
    value === "draft_changed" ||
    value === "intent_changed";
}

function normalizeSemanticResponse(
  value: unknown,
  sessionIndex: number,
  roundIndex: number
): RewriteSemanticReviewResponse {
  try {
    return validateRewriteReviewResponseValue(value);
  } catch {
    throw new Error(`Human Rewrite session ${sessionIndex + 1}, review round ${roundIndex + 1} response is invalid.`);
  }
}

function invalidSession(index: number): Error {
  return new Error(`Human Rewrite session ${index + 1} is invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isSchemaFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

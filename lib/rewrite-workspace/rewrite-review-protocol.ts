import { createContentSha256 } from "../storage/document-recovery-storage.ts";
import type {
  RewriteReviewRequest,
  RewriteReviewRound,
  RewriteSemanticReviewResponse,
  RewriteSession
} from "./rewrite-session-types.ts";

export async function createRewriteSession({
  baseDocumentGeneration,
  baseText,
  documentId,
  documentTitle,
  localProjectInstanceId,
  markdown,
  projectId,
  projectTitle,
  target
}: {
  baseDocumentGeneration: number;
  baseText: string;
  documentId: string;
  documentTitle: string;
  localProjectInstanceId: string;
  markdown: string;
  projectId: string;
  projectTitle: string;
  target: RewriteSession["target"];
}): Promise<RewriteSession> {
  const [baseDocumentSha256, baseTextSha256] = await Promise.all([
    createContentSha256(markdown),
    createContentSha256(baseText)
  ]);
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    rewrite_session_id: createRewriteId("rewrite_session"),
    local_project_instance_id: localProjectInstanceId,
    project_id: projectId,
    document_id: documentId,
    project_title_snapshot: projectTitle,
    document_title_snapshot: documentTitle,
    target,
    base_document_generation: baseDocumentGeneration,
    base_document_sha256: baseDocumentSha256,
    base_text_sha256: baseTextSha256,
    base_text: baseText,
    human_draft_sha256: baseTextSha256,
    human_draft: baseText,
    intent_note: "",
    status: "draft",
    authoritative_revision: 0,
    authoritative_generation: baseDocumentGeneration,
    stale_reference: false,
    created_at: now,
    updated_at: now,
    review_rounds: [],
    reference_history: []
  };
}

export async function updateRewriteDraft({
  humanDraft,
  intentNote,
  session
}: {
  humanDraft: string;
  intentNote: string;
  session: RewriteSession;
}): Promise<RewriteSession> {
  return {
    ...session,
    human_draft: humanDraft,
    human_draft_sha256: await createContentSha256(humanDraft),
    intent_note: intentNote,
    updated_at: new Date().toISOString()
  };
}

export async function buildRewriteReviewRequest(
  session: RewriteSession
): Promise<RewriteReviewRequest> {
  if (session.review_rounds.some((round) => round.status === "awaiting_response")) {
    throw new Error(
      "A semantic review request is already awaiting a response. Cancel it before exporting another round."
    );
  }
  const currentDraftHash = await createContentSha256(session.human_draft);
  const currentBaseHash = await createContentSha256(session.base_text);
  if (
    currentDraftHash !== session.human_draft_sha256 ||
    currentBaseHash !== session.base_text_sha256
  ) {
    throw new Error("Rewrite session fingerprints do not match the stored text.");
  }

  const rewriteReviewId = createRewriteId("rewrite_review");
  const exportedAt = new Date().toISOString();
  const intentNoteSha256 = await createContentSha256(session.intent_note);
  const promptText = createReviewPrompt({
    exportedAt,
    intentNoteSha256,
    rewriteReviewId,
    session
  });
  const promptSha256 = await createContentSha256(promptText);
  const round: RewriteReviewRound = {
    rewrite_review_id: rewriteReviewId,
    request_project_id: session.project_id,
    request_document_id: session.document_id,
    base_text_sha256: session.base_text_sha256,
    human_draft_sha256: session.human_draft_sha256,
    intent_note_sha256: intentNoteSha256,
    prompt_sha256: promptSha256,
    prompt_text: promptText,
    exported_at: exportedAt,
    status: "awaiting_response"
  };
  const nextSession = {
    ...session,
    review_rounds: [...session.review_rounds, round],
    updated_at: exportedAt
  };
  return {
    rewrite_review_id: rewriteReviewId,
    prompt_sha256: promptSha256,
    prompt_text: promptText,
    session: nextSession
  };
}

export function cancelAwaitingRewriteReview(session: RewriteSession): RewriteSession {
  const cancelledAt = new Date().toISOString();
  return {
    ...session,
    review_rounds: session.review_rounds.map((round) =>
      round.status === "awaiting_response"
        ? { ...round, status: "cancelled" as const, cancelled_at: cancelledAt }
        : round
    ),
    updated_at: cancelledAt
  };
}

export function importRewriteReview({
  responseText,
  session
}: {
  responseText: string;
  session: RewriteSession;
}): { current: boolean; response: RewriteSemanticReviewResponse; session: RewriteSession } {
  const response = parseRewriteReviewResponse(responseText);
  const round = session.review_rounds.find(
    (candidate) => candidate.rewrite_review_id === response.rewrite_review_id
  );
  if (!round) {
    throw new Error("This semantic review request does not belong to the rewrite session.");
  }
  if (round.response || round.status === "imported") {
    throw new Error("This semantic review response has already been imported.");
  }
  const mismatches = [
    ["rewrite_session_id", response.rewrite_session_id, session.rewrite_session_id],
    ["project_id", response.project_id, round.request_project_id],
    ["document_id", response.document_id, round.request_document_id],
    ["base_text_sha256", response.base_text_sha256, round.base_text_sha256],
    ["human_draft_sha256", response.human_draft_sha256, round.human_draft_sha256]
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    throw new Error(
      `Semantic review identity mismatch: ${mismatches
        .map(([field]) => field)
        .join(", ")}.`
    );
  }
  const importedAt = new Date().toISOString();
  const current =
    session.base_text_sha256 === response.base_text_sha256 &&
    session.human_draft_sha256 === response.human_draft_sha256;
  return {
    current,
    response,
    session: {
      ...session,
      review_rounds: session.review_rounds.map((candidate) =>
        candidate.rewrite_review_id === response.rewrite_review_id
          ? {
              ...candidate,
              status: "imported" as const,
              imported_at: importedAt,
              response
            }
          : candidate
      ),
      updated_at: importedAt
    }
  };
}

export function getCurrentRewriteReview(session: RewriteSession): RewriteReviewRound | null {
  return (
    [...session.review_rounds]
      .reverse()
      .find(
        (round) =>
          round.status === "imported" &&
          round.response &&
          round.base_text_sha256 === session.base_text_sha256 &&
          round.human_draft_sha256 === session.human_draft_sha256
      ) ?? null
  );
}

export function parseRewriteReviewResponse(
  responseText: string
): RewriteSemanticReviewResponse {
  const parsed = JSON.parse(extractJson(responseText)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("The semantic review response must be a JSON object.");
  }
  requireExactValue(parsed, "protocol", "patchmark.human_rewrite_review_import");
  requireExactValue(parsed, "protocol_version", 1);
  const response: RewriteSemanticReviewResponse = {
    protocol: "patchmark.human_rewrite_review_import",
    protocol_version: 1,
    rewrite_session_id: requireString(parsed, "rewrite_session_id"),
    rewrite_review_id: requireString(parsed, "rewrite_review_id"),
    project_id: requireString(parsed, "project_id"),
    document_id: requireString(parsed, "document_id"),
    base_text_sha256: requireHash(parsed, "base_text_sha256"),
    human_draft_sha256: requireHash(parsed, "human_draft_sha256"),
    overall_assessment: requireEnum(parsed, "overall_assessment", [
      "meaning_preserved",
      "review_recommended",
      "substantial_change",
      "unclear"
    ]),
    summary: requireString(parsed, "summary", true),
    meaning_preserved: requireObjectArray(parsed, "meaning_preserved", (item) => ({
      point: requireString(item, "point"),
      current_text_evidence: requireString(item, "current_text_evidence", true),
      rewrite_evidence: requireString(item, "rewrite_evidence", true)
    })),
    meaning_changed: requireObjectArray(parsed, "meaning_changed", (item) => ({
      topic: requireString(item, "topic"),
      current_meaning: requireString(item, "current_meaning", true),
      rewrite_meaning: requireString(item, "rewrite_meaning", true),
      assessment: requireEnum(item, "assessment", [
        "deliberate",
        "possibly_unintentional",
        "unclear"
      ]),
      severity: requireSeverity(item)
    })),
    omitted_points: requireObjectArray(parsed, "omitted_points", (item) => ({
      point: requireString(item, "point"),
      importance: requireEnum(item, "importance", ["low", "medium", "high"]),
      reason: requireString(item, "reason", true)
    })),
    new_claims: requireObjectArray(parsed, "new_claims", (item) => ({
      claim: requireString(item, "claim"),
      relative_support: requireEnum(item, "relative_support", [
        "present_in_current_text",
        "partially_present_in_current_text",
        "not_present_in_current_text"
      ]),
      note: requireString(item, "note", true)
    })),
    contradictions: requireObjectArray(parsed, "contradictions", (item) => ({
      issue: requireString(item, "issue"),
      severity: requireSeverity(item)
    })),
    certainty_changes: requireObjectArray(parsed, "certainty_changes", (item) => ({
      topic: requireString(item, "topic"),
      from: requireString(item, "from"),
      to: requireString(item, "to"),
      impact: requireString(item, "impact", true)
    })),
    source_impacts: requireObjectArray(parsed, "source_impacts", (item) => ({
      claim_or_source: requireString(item, "claim_or_source"),
      impact: requireEnum(item, "impact", [
        "citation_added",
        "citation_changed",
        "citation_removed",
        "source_support_changed",
        "none"
      ]),
      note: requireString(item, "note", true)
    })),
    ambiguities: requireObjectArray(parsed, "ambiguities", (item) => ({
      issue: requireString(item, "issue"),
      suggestion: requireString(item, "suggestion", true)
    })),
    suggested_draft_edits: requireObjectArray(
      parsed,
      "suggested_draft_edits",
      (item) => ({
        draft_excerpt: requireString(item, "draft_excerpt"),
        suggested_text: requireString(item, "suggested_text"),
        reason: requireString(item, "reason", true)
      })
    )
  };
  return response;
}

function createReviewPrompt({
  exportedAt,
  intentNoteSha256,
  rewriteReviewId,
  session
}: {
  exportedAt: string;
  intentNoteSha256: string;
  rewriteReviewId: string;
  session: RewriteSession;
}): string {
  const payload = {
    protocol: "patchmark.human_rewrite_review_request",
    protocol_version: 1,
    rewrite_session_id: session.rewrite_session_id,
    rewrite_review_id: rewriteReviewId,
    project_id: session.project_id,
    document_id: session.document_id,
    target_kind: session.target.kind,
    heading_snapshot: session.target.heading_snapshot,
    base_text_sha256: session.base_text_sha256,
    human_draft_sha256: session.human_draft_sha256,
    intent_note_sha256: intentNoteSha256,
    exported_at: exportedAt,
    current_text: session.base_text,
    human_draft: session.human_draft,
    intent_note: session.intent_note
  };
  return `# Patchmark Human Rewrite Semantic Review

Compare the human-authored rewrite with the current document text.

The human may intentionally reorganize, simplify, strengthen, weaken, add, or remove meaning. Do not assume every difference is a mistake.

Evaluate meaning preserved, meaning deliberately or possibly unintentionally changed, important points omitted, new claims introduced, contradictions, strengthened or weakened certainty, changed assumptions or qualifications, source and citation implications, ambiguities, and suggested edits to the human draft.

Judge support only relative to the supplied current text and source markers. Do not claim independent factual verification unless explicitly performed.

Do not replace the complete human draft. Do not return Patchmark document patches. Return structured semantic-review JSON only. The human is the author; you are the semantic reviewer.

Preserve the exact rewrite_session_id, rewrite_review_id, project_id, document_id, base_text_sha256, and human_draft_sha256.

Return exactly one fenced JSON code block with protocol \"patchmark.human_rewrite_review_import\", protocol_version 1, the exact identity fields, overall_assessment (meaning_preserved, review_recommended, substantial_change, or unclear), summary, and these arrays: meaning_preserved, meaning_changed, omitted_points, new_claims, contradictions, certainty_changes, source_impacts, ambiguities, suggested_draft_edits.

Request payload:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}

function extractJson(value: string): string {
  const trimmed = value.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

function requireObjectArray<T>(
  record: Record<string, unknown>,
  key: string,
  mapItem: (item: Record<string, unknown>) => T
): T[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object.`);
    }
    return mapItem(item);
  });
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  allowEmpty = false
): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function requireHash(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${key} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function requireSeverity(record: Record<string, unknown>) {
  return requireEnum(record, "severity", ["low", "medium", "high"]);
}

function requireEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function requireExactValue(
  record: Record<string, unknown>,
  key: string,
  expected: string | number
): void {
  if (record[key] !== expected) {
    throw new Error(`${key} must be ${JSON.stringify(expected)}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createRewriteId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

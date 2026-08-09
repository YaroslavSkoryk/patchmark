import { createContentSha256 } from "../storage/document-recovery-storage.ts";
import {
  REWRITE_REVIEW_ARRAY_NAMES,
  REWRITE_REVIEW_IMPORT_PROTOCOL,
  REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION,
  REWRITE_REVIEW_PROMPT_GENERATOR_VERSION,
  REWRITE_REVIEW_PROMPT_SCHEMA_VERSION,
  REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT,
  RewriteReviewValidationError,
  createRewriteReviewResponseSkeleton,
  createRewriteReviewSchemaInstructions,
  parseRewriteReviewJsonValue,
  validateRewriteReviewResponseIdentity,
  validateRewriteReviewResponseValue,
  type RewriteReviewResponseIdentity,
  type RewriteReviewValidationIssue
} from "./rewrite-review-schema.ts";
import type {
  RewriteReviewRequest,
  RewriteReviewRound,
  RewriteReviewSupersessionReason,
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
  const awaitingRound = getAwaitingRewriteReview(session);
  if (awaitingRound) {
    throw new Error(
      getRewriteReviewPromptFormat(awaitingRound) === "outdated"
        ? "An outdated semantic-review request is awaiting a response. Generate an updated review prompt instead of reopening it."
        : "A semantic review request is already awaiting a response. Cancel it before exporting another round."
    );
  }
  return createCurrentRewriteReviewRequest({ session });
}

export async function regenerateOutdatedRewriteReviewRequest(
  session: RewriteSession
): Promise<RewriteReviewRequest> {
  const awaitingRound = getAwaitingRewriteReview(session);
  return regenerateRewriteReviewRequest({
    expectedReviewRequestId: awaitingRound?.rewrite_review_id ?? "",
    reason: "outdated_prompt_format",
    session
  });
}

export async function regenerateRewriteReviewRequest({
  expectedReviewRequestId,
  reason,
  session
}: {
  expectedReviewRequestId: string;
  reason: RewriteReviewSupersessionReason;
  session: RewriteSession;
}): Promise<RewriteReviewRequest> {
  const awaitingRound = getAwaitingRewriteReview(session);
  if (!awaitingRound) {
    throw new Error("There is no awaiting semantic-review request to regenerate.");
  }
  if (awaitingRound.rewrite_review_id !== expectedReviewRequestId) {
    throw new Error(
      "The active semantic-review request changed before regeneration. Reload the current request and try again."
    );
  }
  if (
    awaitingRound.request_project_id !== session.project_id ||
    awaitingRound.request_document_id !== session.document_id
  ) {
    throw new Error("The active semantic-review request does not belong to this project document.");
  }
  if (
    reason === "outdated_prompt_format" &&
    getRewriteReviewPromptFormat(awaitingRound) !== "outdated"
  ) {
    throw new Error("The awaiting semantic-review request already uses the current prompt format.");
  }
  const request = await createCurrentRewriteReviewRequest({
    session,
    supersedesReviewRequestId: awaitingRound.rewrite_review_id
  });
  const supersededAt = request.session.updated_at;
  const nextSession: RewriteSession = {
    ...request.session,
    review_rounds: request.session.review_rounds.map((round) =>
      round.rewrite_review_id === awaitingRound.rewrite_review_id
        ? {
            ...round,
            status: "superseded" as const,
            superseded_at: supersededAt,
            superseded_reason: reason,
            superseded_by_review_request_id: request.rewrite_review_id
          }
        : round
    )
  };
  return { ...request, session: nextSession };
}

export function getAwaitingRewriteReview(
  session: RewriteSession
): RewriteReviewRound | null {
  return (
    [...session.review_rounds]
      .reverse()
      .find((round) => round.status === "awaiting_response") ?? null
  );
}

export function getRewriteReviewPromptFormat(
  round: RewriteReviewRound
): "current" | "outdated" {
  return round.prompt_schema_version === REWRITE_REVIEW_PROMPT_SCHEMA_VERSION &&
    round.response_schema_fingerprint === REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT &&
    round.prompt_generator_version === REWRITE_REVIEW_PROMPT_GENERATOR_VERSION &&
    typeof round.prompt_created_at === "string"
    ? "current"
    : "outdated";
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
}): {
  current: boolean;
  historical: boolean;
  response: RewriteSemanticReviewResponse;
  session: RewriteSession;
} {
  const parsed = parseRewriteReviewJsonValue(responseText);
  const responseIdentity = validateRewriteReviewResponseIdentity(parsed);
  const round = session.review_rounds.find(
    (candidate) => candidate.rewrite_review_id === responseIdentity.rewrite_review_id
  );
  if (!round) {
    throw new RewriteReviewValidationError({
      category: "lifecycle",
      guidance: "Select the response for a review request exported from this Rewrite Workspace, or export a fresh request.",
      issues: [
        {
          path: "rewrite_review_id",
          code: "review_request_not_found",
          expected: "an exported review request in this rewrite session",
          actualType: "string",
          actualValue: responseIdentity.rewrite_review_id,
          message: "This semantic review request does not belong to the rewrite session."
        }
      ],
      repairPromptEligible: false,
      reviewRequestId: responseIdentity.rewrite_review_id
    });
  }
  if (round.status === "cancelled") {
    throw new RewriteReviewValidationError({
      category: "lifecycle",
      guidance: "Export a fresh semantic-review request. Cancelled requests cannot receive imports.",
      issues: [
        {
          path: "rewrite_review_id",
          code: "cancelled_review_request",
          expected: "an awaiting review request",
          actualType: "cancelled review request",
          actualValue: responseIdentity.rewrite_review_id,
          message: "This semantic review request was cancelled."
        }
      ],
      repairPromptEligible: false,
      reviewRequestId: round.rewrite_review_id,
      reviewRequestStatus: round.status
    });
  }
  if (round.response || round.status === "imported") {
    throw new RewriteReviewValidationError({
      category: "lifecycle",
      guidance: "This round is already stored. Export another review request only if you want a new review round.",
      issues: [
        {
          path: "rewrite_review_id",
          code: "duplicate_review_import",
          expected: "a review request without an imported response",
          actualType: "already imported review request",
          actualValue: responseIdentity.rewrite_review_id,
          message: "This semantic review response has already been imported."
        }
      ],
      repairPromptEligible: false,
      reviewRequestId: round.rewrite_review_id,
      reviewRequestStatus: round.status
    });
  }
  const mismatches = [
    ["rewrite_session_id", responseIdentity.rewrite_session_id, session.rewrite_session_id],
    ["project_id", responseIdentity.project_id, round.request_project_id],
    ["document_id", responseIdentity.document_id, round.request_document_id],
    ["base_text_sha256", responseIdentity.base_text_sha256, round.base_text_sha256],
    ["human_draft_sha256", responseIdentity.human_draft_sha256, round.human_draft_sha256]
  ] as const;
  const mismatchIssues = mismatches.flatMap(([field, actual, expected]) =>
    actual === expected
      ? []
      : [
          {
            path: field,
            code: field.endsWith("_sha256") ? "hash_mismatch" : "identity_mismatch",
            expected,
            actualType: "string",
            actualValue: actual,
            message: `${field} does not match the exported review request.`
          } satisfies RewriteReviewValidationIssue
        ]
  );
  if (mismatchIssues.length > 0) {
    throw new RewriteReviewValidationError({
      category: "identity",
      guidance: mismatchIssues.some((issue) => issue.path === "human_draft_sha256")
        ? "This response does not match its exported Human Draft. Use the exact response for this round or export a fresh request. Earlier-draft reviews remain supported when their exported hash is unchanged."
        : "Use the response from this exact exported review request, or export a fresh request.",
      issues: mismatchIssues,
      message: `Semantic review identity mismatch: ${mismatchIssues.map((issue) => issue.path).join(", ")}.`,
      repairPromptEligible: false,
      reviewRequestId: round.rewrite_review_id,
      reviewRequestStatus: round.status
    });
  }
  let response: RewriteSemanticReviewResponse;
  try {
    response = validateRewriteReviewResponseValue(parsed);
  } catch (error) {
    if (error instanceof RewriteReviewValidationError) {
      throw new RewriteReviewValidationError({
        category: error.category,
        guidance: round.status === "superseded"
          ? getRewriteReviewPromptFormat(round) === "outdated"
            ? "This response belongs to a superseded review request that used an older response format. Repair its structure only to store it historically, or use the newer active request for a current review."
            : "This response belongs to a superseded review request. Repair its structure only to store it historically, or use the active request for a current review."
          : error.guidance,
        issues: error.issues,
        message: error.message,
        repairPromptEligible: error.repairPromptEligible,
        reviewRequestId: round.rewrite_review_id,
        reviewRequestStatus: round.status
      });
    }
    throw error;
  }
  const importedAt = new Date().toISOString();
  const current =
    round.status !== "superseded" &&
    session.base_text_sha256 === response.base_text_sha256 &&
    session.human_draft_sha256 === response.human_draft_sha256;
  return {
    current,
    historical: round.status === "superseded",
    response,
    session: {
      ...session,
      review_rounds: session.review_rounds.map((candidate) =>
        candidate.rewrite_review_id === response.rewrite_review_id
          ? {
              ...candidate,
              status: candidate.status === "superseded"
                ? "superseded" as const
                : "imported" as const,
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
  return validateRewriteReviewResponseValue(
    parseRewriteReviewJsonValue(responseText)
  );
}

export async function createRewriteReviewRepairPrompt({
  error,
  responseText,
  session
}: {
  error: unknown;
  responseText: string;
  session: RewriteSession;
}): Promise<string | null> {
  if (
    !(error instanceof RewriteReviewValidationError) ||
    !error.repairPromptEligible
  ) {
    return null;
  }
  let responseReviewId: string | null = error.reviewRequestId ?? null;
  if (!responseReviewId) {
    try {
      responseReviewId = validateRewriteReviewResponseIdentity(
        parseRewriteReviewJsonValue(responseText)
      ).rewrite_review_id;
    } catch {
      responseReviewId = null;
    }
  }
  const round = responseReviewId
    ? session.review_rounds.find(
        (candidate) => candidate.rewrite_review_id === responseReviewId
      )
    : getAwaitingRewriteReview(session);
  if (!round) {
    return null;
  }
  const identity: RewriteReviewResponseIdentity = {
    rewrite_session_id: session.rewrite_session_id,
    rewrite_review_id: round.rewrite_review_id,
    project_id: round.request_project_id,
    document_id: round.request_document_id,
    base_text_sha256: round.base_text_sha256,
    human_draft_sha256: round.human_draft_sha256
  };
  const responseSha256 = await createContentSha256(responseText);
  const responseBytes = new TextEncoder().encode(responseText).byteLength;
  const issueText = error.issues
    .map((issue, index) => {
      const details = [
        `${index + 1}. ${issue.path} [${issue.code}]`,
        `   ${issue.message}`,
        `   Expected: ${issue.expected}`,
        ...(issue.actualType ? [`   Received: ${issue.actualType}`] : []),
        ...(issue.example !== undefined
          ? [`   Required shape example: ${JSON.stringify(issue.example)}`]
          : [])
      ];
      return details.join("\n");
    })
    .join("\n");
  const supersededNotice = round.status === "superseded"
    ? getRewriteReviewPromptFormat(round) === "outdated"
      ? `\nThis request used an older prompt format. The repaired response may be stored as a historical review. To review the current draft using the latest format, use the active review request in Patchmark.\n`
      : `\nThis request was superseded by a newer review request. The repaired response may be stored only as a historical review of this exact request.\n`
    : "";
  return `# Repair a Patchmark Human Rewrite semantic-review response

Repair the previous Patchmark semantic-review response.

This response belongs to review request:
${round.rewrite_review_id}

Repair its structure only.

Do not replace the request ID with a newer request ID.
${supersededNotice}

Do not change the substance of the review unless required to place existing content into the required fields.

Every item in every semantic-review array must be a JSON object.
Never place a string, number, boolean, or null directly inside a review array.
Use an empty array when there are no findings.
Do not omit required fields from an item object.
Preserve all protocol identities and hashes exactly.
Return exactly one fenced JSON code block and no prose outside it.
Do not add explanatory prose.

Exact identities to preserve:

\`\`\`json
${JSON.stringify(
  {
    protocol: REWRITE_REVIEW_IMPORT_PROTOCOL,
    protocol_version: REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION,
    ...identity
  },
  null,
  2
)}
\`\`\`

Validation problems:

${issueText}

Canonical field rules:

${createRewriteReviewSchemaInstructions()}

Complete canonical response skeleton:

\`\`\`json
${JSON.stringify(createRewriteReviewResponseSkeleton(identity), null, 2)}
\`\`\`

Original response fidelity:
- UTF-8 byte length: ${responseBytes}
- SHA-256: ${responseSha256}

BEGIN EXACT ORIGINAL RESPONSE
${responseText}
END EXACT ORIGINAL RESPONSE`;
}

export function createRewriteReviewPersistenceError(
  error: unknown
): RewriteReviewValidationError {
  const detail = error instanceof Error ? error.message : String(error);
  return new RewriteReviewValidationError({
    category: "persistence",
    guidance: "The validated response was not imported. Keep this dialog open and retry after project saving is available.",
    issues: [
      {
        path: "project_persistence",
        code: "persistence_failure",
        expected: "one complete authoritative project save",
        actualType: "save failure",
        message: detail
      }
    ],
    message: "The response is valid, but Patchmark could not save the review.",
    repairPromptEligible: false
  });
}

async function createCurrentRewriteReviewRequest({
  session,
  supersedesReviewRequestId
}: {
  session: RewriteSession;
  supersedesReviewRequestId?: string;
}): Promise<RewriteReviewRequest> {
  const [currentDraftHash, currentBaseHash] = await Promise.all([
    createContentSha256(session.human_draft),
    createContentSha256(session.base_text)
  ]);
  if (
    currentDraftHash !== session.human_draft_sha256 ||
    currentBaseHash !== session.base_text_sha256
  ) {
    throw new Error("Rewrite session fingerprints do not match the stored text.");
  }

  const rewriteReviewId = createRewriteId("rewrite_review");
  const promptCreatedAt = new Date().toISOString();
  const intentNoteSha256 = await createContentSha256(session.intent_note);
  const promptText = createReviewPrompt({
    intentNoteSha256,
    promptCreatedAt,
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
    prompt_byte_length: new TextEncoder().encode(promptText).byteLength,
    exported_at: promptCreatedAt,
    prompt_schema_version: REWRITE_REVIEW_PROMPT_SCHEMA_VERSION,
    response_schema_fingerprint: REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT,
    prompt_created_at: promptCreatedAt,
    prompt_generator_version: REWRITE_REVIEW_PROMPT_GENERATOR_VERSION,
    status: "awaiting_response",
    ...(supersedesReviewRequestId
      ? { supersedes_review_request_id: supersedesReviewRequestId }
      : {})
  };
  const nextSession: RewriteSession = {
    ...session,
    review_rounds: [...session.review_rounds, round],
    updated_at: promptCreatedAt
  };
  return {
    rewrite_review_id: rewriteReviewId,
    prompt_sha256: promptSha256,
    prompt_text: promptText,
    session: nextSession
  };
}

function createReviewPrompt({
  intentNoteSha256,
  promptCreatedAt,
  rewriteReviewId,
  session
}: {
  intentNoteSha256: string;
  promptCreatedAt: string;
  rewriteReviewId: string;
  session: RewriteSession;
}): string {
  const identity: RewriteReviewResponseIdentity = {
    rewrite_session_id: session.rewrite_session_id,
    rewrite_review_id: rewriteReviewId,
    project_id: session.project_id,
    document_id: session.document_id,
    base_text_sha256: session.base_text_sha256,
    human_draft_sha256: session.human_draft_sha256
  };
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
    prompt_schema_version: REWRITE_REVIEW_PROMPT_SCHEMA_VERSION,
    response_schema_fingerprint: REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT,
    prompt_created_at: promptCreatedAt,
    prompt_generator_version: REWRITE_REVIEW_PROMPT_GENERATOR_VERSION,
    exported_at: promptCreatedAt,
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

Copy without modification the exact protocol, protocol_version, rewrite_session_id, rewrite_review_id, project_id, document_id, base_text_sha256, and human_draft_sha256 shown in the canonical skeleton. Do not regenerate, shorten, capitalize, or otherwise alter them.

This request uses prompt_schema_version ${REWRITE_REVIEW_PROMPT_SCHEMA_VERSION} and expects response_schema_fingerprint ${REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT}. These identify the request format and expected response shape. They are request metadata, not response fields in response protocol version ${REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION}.

Every item in every semantic-review array must be a JSON object.

Never place a string directly inside:
${REWRITE_REVIEW_ARRAY_NAMES.map((name) => `- ${name}`).join("\n")}

Never place a number, boolean, or null directly inside any semantic-review array.

Use [] when there are no findings.

Do not summarize findings as string arrays.

Do not omit required object fields.

Return exactly one fenced JSON code block and no prose outside it.

All nine semantic-review arrays are required. Every item field listed below is required in protocol version 1; no item fields are optional. Fields explicitly documented as accepting an empty string must still be present. Enum values are case-sensitive and are not normalized.

Canonical field rules:

${createRewriteReviewSchemaInstructions()}

Complete canonical response skeleton using the exact request identities:

\`\`\`json
${JSON.stringify(createRewriteReviewResponseSkeleton(identity), null, 2)}
\`\`\`

Empty findings must use an empty array, for example:

\`\`\`json
${JSON.stringify({ contradictions: [], ambiguities: [] }, null, 2)}
\`\`\`

Invalid string-array example:

\`\`\`json
${JSON.stringify({ meaning_preserved: ["The conclusion remains."] }, null, 2)}
\`\`\`

INVALID — array items may not be strings.

Your response must use protocol \"${REWRITE_REVIEW_IMPORT_PROTOCOL}\", protocol_version ${REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION}, overall_assessment (meaning_preserved, review_recommended, substantial_change, or unclear), summary, and exactly these required arrays: ${REWRITE_REVIEW_ARRAY_NAMES.join(", ")}.

Request payload:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Before returning the JSON, check:

1. Every review array contains only objects.
2. Every object contains all required fields.
3. Empty categories use [].
4. All enum values match the allowed values exactly.
5. All IDs and hashes are copied exactly.
6. There is exactly one JSON object.
7. There is no prose outside the JSON fence.`;
}

function createRewriteId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

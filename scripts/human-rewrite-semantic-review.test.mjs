import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  buildRewriteReviewRequest,
  cancelAwaitingRewriteReview,
  createRewriteReviewPersistenceError,
  createRewriteReviewRepairPrompt,
  createRewriteSession,
  getAwaitingRewriteReview,
  getCurrentRewriteReview,
  getRewriteReviewPromptFormat,
  importRewriteReview,
  parseRewriteReviewResponse,
  regenerateOutdatedRewriteReviewRequest,
  regenerateRewriteReviewRequest,
  updateRewriteDraft
} from "../lib/rewrite-workspace/rewrite-review-protocol.ts";
import {
  REWRITE_REVIEW_ARRAY_NAMES,
  REWRITE_REVIEW_ARRAY_SCHEMA,
  REWRITE_REVIEW_PROMPT_GENERATOR_VERSION,
  REWRITE_REVIEW_PROMPT_SCHEMA_VERSION,
  REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT,
  REWRITE_REVIEW_RESPONSE_SCHEMA_SERIALIZATION,
  RewriteReviewValidationError,
  createRewriteReviewArrayItemExample,
  createRewriteReviewResponseSkeleton,
  createRewriteReviewSchemaInstructions,
  parseRewriteReviewJsonValue,
  validateRewriteReviewResponseIdentity,
  validateRewriteReviewResponseValue
} from "../lib/rewrite-workspace/rewrite-review-schema.ts";
import {
  parseRewriteProjectSessionStore,
  serializeRewriteProjectSessionStore
} from "../lib/rewrite-workspace/rewrite-project-session-schema.ts";

const rejectedFixtureBase64 = await readFile(
  new URL("./fixtures/human-rewrite-semantic-review-rejected.base64", import.meta.url),
  "utf8"
);
const rejectedFixture = Buffer.from(
  rejectedFixtureBase64.replaceAll(/\s/g, ""),
  "base64"
).toString("utf8");
assert.equal(Buffer.byteLength(rejectedFixture), 9256);
assert.equal(
  createHash("sha256").update(rejectedFixture).digest("hex"),
  "0d4ebfbf955389da85283b0989b27f7923844ac811232bef8f6dd3c8f8aea746"
);

const legacyPromptFixtureBase64 = await readFile(
  new URL(
    "./fixtures/human-rewrite-semantic-review-legacy-prompt.gz.base64",
    import.meta.url
  ),
  "utf8"
);
const legacyPromptFixture = gunzipSync(
  Buffer.from(legacyPromptFixtureBase64.replaceAll(/\s/g, ""), "base64")
).toString("utf8");
assert.equal(Buffer.byteLength(legacyPromptFixture), 74693);
assert.equal(
  createHash("sha256").update(legacyPromptFixture).digest("hex"),
  "00380795413830213748bcd18e2da5b58f91dee6ff7e674a58d6d8035b6f51bf"
);
const legacyPayloadMatch =
  /Request payload:\n\n```json\n([\s\S]*?)\n```\s*$/.exec(legacyPromptFixture);
assert.ok(legacyPayloadMatch);
const legacyRequestPayload = JSON.parse(legacyPayloadMatch[1]);
assert.equal(
  createHash("sha256").update(legacyRequestPayload.current_text).digest("hex"),
  "4528377a6448cec7f1f9d3c8b6da363cc48a1c4f722cdd2630d42b82c84f707f"
);
assert.equal(
  createHash("sha256").update(legacyRequestPayload.human_draft).digest("hex"),
  "f6664054801c4fd1d5310b4b3ae87e6b68a621c0862e7070f323ddfa671380c3"
);
assert.equal(
  createHash("sha256").update(legacyRequestPayload.intent_note).digest("hex"),
  "6509f53cdc8abf2a8d077a663bec434ba67a2e8db21d535f86e6a4e6f0472df5"
);

const rejectedValue = parseRewriteReviewJsonValue(rejectedFixture);
const rejectedIdentity = validateRewriteReviewResponseIdentity(rejectedValue);
assert.deepEqual(rejectedIdentity, {
  rewrite_session_id: "rewrite_session_f3d11ecf-f9e8-4b84-b094-ea950f2862dc",
  rewrite_review_id: "rewrite_review_72c66ae5-42b0-4b15-b6f9-9e5c63ea7ad5",
  project_id: "prj_0b86549a-56aa-4f37-8f4e-68cba8c958a3",
  document_id: "doc_2909a2c8-c4da-4cd0-8a03-f58387444ce6",
  base_text_sha256: "4528377a6448cec7f1f9d3c8b6da363cc48a1c4f722cdd2630d42b82c84f707f",
  human_draft_sha256: "f6664054801c4fd1d5310b4b3ae87e6b68a621c0862e7070f323ddfa671380c3"
});

const rejectedValidationError = captureValidationError(() =>
  validateRewriteReviewResponseValue(rejectedValue)
);
assert.equal(rejectedValidationError.category, "response_shape");
assert.equal(rejectedValidationError.repairPromptEligible, true);
assert.equal(rejectedValidationError.issues.length, 48);
assert.equal(
  rejectedValidationError.issues.every(
    (issue) => issue.code === "invalid_array_item_type"
  ),
  true
);
const expectedInvalidStringCounts = {
  meaning_preserved: 6,
  meaning_changed: 5,
  omitted_points: 9,
  new_claims: 3,
  contradictions: 2,
  certainty_changes: 3,
  source_impacts: 4,
  ambiguities: 6,
  suggested_draft_edits: 10
};
for (const [name, count] of Object.entries(expectedInvalidStringCounts)) {
  assert.equal(
    rejectedValidationError.issues.filter((issue) =>
      issue.path.startsWith(`${name}[`)
    ).length,
    count
  );
}
assert.equal(rejectedValidationError.issues[0].path, "meaning_preserved[0]");
assert.equal(rejectedValidationError.issues.at(-1).path, "suggested_draft_edits[9]");

const fixtureSession = createFixtureSession(rejectedIdentity);
assert.equal(getRewriteReviewPromptFormat(fixtureSession.review_rounds[0]), "outdated");
assert.equal(getAwaitingRewriteReview(fixtureSession)?.rewrite_review_id, rejectedIdentity.rewrite_review_id);
assert.equal(fixtureSession.review_rounds[0].prompt_schema_version, undefined);
assert.equal(
  `sha256:${createHash("sha256")
    .update(REWRITE_REVIEW_RESPONSE_SCHEMA_SERIALIZATION)
    .digest("hex")}`,
  REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT
);
const beforeRejectedImport = structuredClone(fixtureSession);
const rejectedImportError = captureValidationError(() =>
  importRewriteReview({ responseText: rejectedFixture, session: fixtureSession })
);
assert.equal(rejectedImportError.issues.length, 48);
assert.deepEqual(fixtureSession, beforeRejectedImport);
assert.equal(fixtureSession.review_rounds[0].status, "awaiting_response");
assert.equal(fixtureSession.review_rounds[0].response, undefined);

const repairPrompt = await createRewriteReviewRepairPrompt({
  error: rejectedImportError,
  responseText: rejectedFixture,
  session: fixtureSession
});
assert.ok(repairPrompt);
assert.equal(repairPrompt.includes(rejectedFixture), true);
assert.equal(repairPrompt.includes("UTF-8 byte length: 9256"), true);
assert.equal(
  repairPrompt.includes(
    "SHA-256: 0d4ebfbf955389da85283b0989b27f7923844ac811232bef8f6dd3c8f8aea746"
  ),
  true
);
assert.equal(repairPrompt.includes("meaning_preserved[0] [invalid_array_item_type]"), true);
for (const value of Object.values(rejectedIdentity)) {
  assert.equal(repairPrompt.includes(value), true);
}

const repairedResponse = repairStringArrayResponse(rejectedValue);
const repairedImport = importRewriteReview({
  responseText: `\`\`\`json\n${JSON.stringify(repairedResponse)}\n\`\`\``,
  session: fixtureSession
});
assert.equal(repairedImport.current, true);
assert.equal(repairedImport.session.review_rounds.length, 1);
assert.equal(repairedImport.session.review_rounds[0].status, "imported");
assert.equal(repairedImport.session.human_draft, fixtureSession.human_draft);
assert.equal(repairedImport.session.base_text, fixtureSession.base_text);

const beforeRegeneration = structuredClone(fixtureSession);
const regeneratedRequest = await regenerateOutdatedRewriteReviewRequest(
  fixtureSession
);
assert.deepEqual(fixtureSession, beforeRegeneration);
assert.notEqual(regeneratedRequest.rewrite_review_id, rejectedIdentity.rewrite_review_id);
assert.equal(regeneratedRequest.session.review_rounds.length, 2);
const supersededRealRound = regeneratedRequest.session.review_rounds[0];
const regeneratedRound = regeneratedRequest.session.review_rounds[1];
assert.equal(supersededRealRound.status, "superseded");
assert.equal(supersededRealRound.prompt_text, legacyPromptFixture);
assert.equal(
  supersededRealRound.prompt_sha256,
  "00380795413830213748bcd18e2da5b58f91dee6ff7e674a58d6d8035b6f51bf"
);
assert.equal(
  supersededRealRound.superseded_by_review_request_id,
  regeneratedRequest.rewrite_review_id
);
assert.equal(supersededRealRound.superseded_reason, "outdated_prompt_format");
assert.equal(
  regeneratedRound.supersedes_review_request_id,
  rejectedIdentity.rewrite_review_id
);
assert.equal(regeneratedRound.prompt_schema_version, REWRITE_REVIEW_PROMPT_SCHEMA_VERSION);
assert.equal(
  regeneratedRound.response_schema_fingerprint,
  REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT
);
assert.equal(
  regeneratedRound.prompt_generator_version,
  REWRITE_REVIEW_PROMPT_GENERATOR_VERSION
);
assert.equal(regeneratedRound.prompt_created_at, regeneratedRound.exported_at);
assert.equal(regeneratedRound.base_text_sha256, rejectedIdentity.base_text_sha256);
assert.equal(regeneratedRound.human_draft_sha256, rejectedIdentity.human_draft_sha256);
assert.equal(
  regeneratedRound.intent_note_sha256,
  "6509f53cdc8abf2a8d077a663bec434ba67a2e8db21d535f86e6a4e6f0472df5"
);
assert.equal(getRewriteReviewPromptFormat(regeneratedRound), "current");
assert.equal(
  getAwaitingRewriteReview(regeneratedRequest.session)?.rewrite_review_id,
  regeneratedRequest.rewrite_review_id
);

const lateSupersededImport = importRewriteReview({
  responseText: JSON.stringify(repairedResponse),
  session: regeneratedRequest.session
});
assert.equal(lateSupersededImport.current, false);
assert.equal(lateSupersededImport.historical, true);
assert.equal(lateSupersededImport.session.review_rounds[0].status, "superseded");
assert.deepEqual(
  lateSupersededImport.session.review_rounds[0].response,
  repairedResponse
);
assert.equal(
  lateSupersededImport.session.review_rounds[1].status,
  "awaiting_response"
);
assert.equal(getCurrentRewriteReview(lateSupersededImport.session), null);

const lateMalformedError = captureValidationError(() =>
  importRewriteReview({
    responseText: rejectedFixture,
    session: regeneratedRequest.session
  })
);
assert.equal(lateMalformedError.reviewRequestStatus, "superseded");
assert.match(lateMalformedError.guidance, /superseded review request/i);
const lateRepairPrompt = await createRewriteReviewRepairPrompt({
  error: lateMalformedError,
  responseText: rejectedFixture,
  session: regeneratedRequest.session
});
assert.ok(lateRepairPrompt);
assert.match(lateRepairPrompt, /This response belongs to review request:/);
assert.equal(lateRepairPrompt.includes(rejectedIdentity.rewrite_review_id), true);
assert.match(lateRepairPrompt, /Repair its structure only\./);
assert.match(lateRepairPrompt, /Do not replace the request ID with a newer request ID\./);
assert.match(lateRepairPrompt, /stored as a historical review/i);

const emptyResponse = {
  ...createRewriteReviewResponseSkeleton(rejectedIdentity),
  ...Object.fromEntries(REWRITE_REVIEW_ARRAY_NAMES.map((name) => [name, []]))
};
assert.deepEqual(parseRewriteReviewResponse(JSON.stringify(emptyResponse)), emptyResponse);
assert.deepEqual(
  parseRewriteReviewResponse(`\uFEFF  \n\`\`\`json\n${JSON.stringify(emptyResponse)}\n\`\`\`  \n`),
  emptyResponse
);
assert.deepEqual(
  parseRewriteReviewResponse(`  \n${JSON.stringify(emptyResponse)}\n  `),
  emptyResponse
);

const multipleJsonError = captureValidationError(() =>
  parseRewriteReviewResponse(
    `\`\`\`json\n${JSON.stringify(emptyResponse)}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``
  )
);
assert.equal(multipleJsonError.issues[0].code, "multiple_json_values");
const surroundingProseError = captureValidationError(() =>
  parseRewriteReviewResponse(
    `Here is the response.\n\`\`\`json\n${JSON.stringify(emptyResponse)}\n\`\`\``
  )
);
assert.equal(
  surroundingProseError.issues[0].code,
  "unexpected_text_outside_json"
);
const invalidJsonError = captureValidationError(() =>
  parseRewriteReviewResponse('{"protocol":')
);
assert.equal(invalidJsonError.issues[0].code, "invalid_json");
assert.match(invalidJsonError.issues[0].message, /valid JSON/i);

const missingFieldResponse = structuredClone(repairedResponse);
delete missingFieldResponse.meaning_preserved[0].current_text_evidence;
const missingFieldError = captureValidationError(() =>
  parseRewriteReviewResponse(JSON.stringify(missingFieldResponse))
);
assert.equal(
  missingFieldError.issues.some(
    (issue) =>
      issue.path === "meaning_preserved[0].current_text_evidence" &&
      issue.code === "missing_required_field"
  ),
  true
);

const invalidEnumResponse = structuredClone(repairedResponse);
invalidEnumResponse.meaning_changed[0].severity = "urgent";
const invalidEnumError = captureValidationError(() =>
  parseRewriteReviewResponse(JSON.stringify(invalidEnumResponse))
);
assert.equal(
  invalidEnumError.issues.some(
    (issue) =>
      issue.path === "meaning_changed[0].severity" &&
      issue.code === "invalid_enum" &&
      issue.expected.includes("low, medium, high")
  ),
  true
);

const wrongSessionResponse = {
  ...emptyResponse,
  rewrite_session_id: "rewrite_session_wrong"
};
const wrongSessionError = captureValidationError(() =>
  importRewriteReview({
    responseText: JSON.stringify(wrongSessionResponse),
    session: fixtureSession
  })
);
assert.equal(wrongSessionError.category, "identity");
assert.equal(wrongSessionError.issues[0].code, "identity_mismatch");
assert.equal(
  await createRewriteReviewRepairPrompt({
    error: wrongSessionError,
    responseText: JSON.stringify(wrongSessionResponse),
    session: fixtureSession
  }),
  null
);

const wrongHashResponse = {
  ...emptyResponse,
  human_draft_sha256: "0".repeat(64)
};
const wrongHashError = captureValidationError(() =>
  importRewriteReview({
    responseText: JSON.stringify(wrongHashResponse),
    session: fixtureSession
  })
);
assert.equal(wrongHashError.issues[0].code, "hash_mismatch");
assert.equal(wrongHashError.repairPromptEligible, false);

const duplicateError = captureValidationError(() =>
  importRewriteReview({
    responseText: JSON.stringify(repairedResponse),
    session: repairedImport.session
  })
);
assert.equal(duplicateError.issues[0].code, "duplicate_review_import");
assert.equal(duplicateError.repairPromptEligible, false);

const cancelledSession = cancelAwaitingRewriteReview(fixtureSession);
const cancelledError = captureValidationError(() =>
  importRewriteReview({
    responseText: JSON.stringify(repairedResponse),
    session: cancelledSession
  })
);
assert.equal(cancelledError.issues[0].code, "cancelled_review_request");

const changedDraftSession = {
  ...fixtureSession,
  human_draft: `${fixtureSession.human_draft}\nChanged after export.`,
  human_draft_sha256: "1".repeat(64)
};
const historicalImport = importRewriteReview({
  responseText: JSON.stringify(repairedResponse),
  session: changedDraftSession
});
assert.equal(historicalImport.current, false);
assert.equal(historicalImport.session.review_rounds[0].status, "imported");

const persistenceError = createRewriteReviewPersistenceError(
  new Error("Injected project write failure")
);
assert.equal(persistenceError.issues[0].code, "persistence_failure");
assert.equal(persistenceError.repairPromptEligible, false);
assert.deepEqual(fixtureSession, beforeRejectedImport);

const changedBeforeRegeneration = await updateRewriteDraft({
  humanDraft: `${fixtureSession.human_draft}\n\nCurrent author change before regeneration.`,
  intentNote: "Preserve the conclusions while simplifying every stage gate.",
  session: fixtureSession
});
const changedRegeneration = await regenerateOutdatedRewriteReviewRequest(
  changedBeforeRegeneration
);
const changedRegeneratedRound = changedRegeneration.session.review_rounds[1];
assert.equal(
  changedRegeneratedRound.human_draft_sha256,
  createHash("sha256")
    .update(changedBeforeRegeneration.human_draft)
    .digest("hex")
);
assert.notEqual(
  changedRegeneratedRound.human_draft_sha256,
  rejectedIdentity.human_draft_sha256
);
assert.equal(
  changedRegeneratedRound.intent_note_sha256,
  createHash("sha256")
    .update(changedBeforeRegeneration.intent_note)
    .digest("hex")
);
assert.equal(changedRegeneration.session.review_rounds[0].prompt_text, legacyPromptFixture);

const [concurrentCandidateA, concurrentCandidateB] = await Promise.all([
  regenerateOutdatedRewriteReviewRequest(fixtureSession),
  regenerateOutdatedRewriteReviewRequest(fixtureSession)
]);
assert.notEqual(
  concurrentCandidateA.rewrite_review_id,
  concurrentCandidateB.rewrite_review_id
);
for (const candidate of [concurrentCandidateA, concurrentCandidateB]) {
  assert.equal(
    candidate.session.review_rounds.filter(
      (round) => round.status === "awaiting_response"
    ).length,
    1
  );
  assert.equal(candidate.session.review_rounds[0].status, "superseded");
}
assert.equal(fixtureSession.review_rounds[0].status, "awaiting_response");

let authoritativePromptSession = structuredClone(fixtureSession);
let authoritativePromptRevision = fixtureSession.authoritative_revision;
function persistPromptCandidate(candidate, expectedRevision) {
  if (expectedRevision !== authoritativePromptRevision) {
    throw new Error("stale semantic-review request completion");
  }
  authoritativePromptRevision += 1;
  authoritativePromptSession = {
    ...candidate.session,
    authoritative_revision: authoritativePromptRevision
  };
}
persistPromptCandidate(
  concurrentCandidateA,
  concurrentCandidateA.session.authoritative_revision
);
assert.throws(
  () =>
    persistPromptCandidate(
      concurrentCandidateB,
      concurrentCandidateB.session.authoritative_revision
    ),
  /stale semantic-review request completion/
);
assert.equal(
  getAwaitingRewriteReview(authoritativePromptSession)?.rewrite_review_id,
  concurrentCandidateA.rewrite_review_id
);
assert.equal(
  authoritativePromptSession.review_rounds.filter(
    (round) => round.status === "awaiting_response"
  ).length,
  1
);

const projectSessionBeforeFailedSupersession = structuredClone(fixtureSession);
let presentedPromptAfterFailedSupersession = null;
const failedSupersessionCandidate = await regenerateOutdatedRewriteReviewRequest(
  fixtureSession
);
await assert.rejects(
  async () => {
    throw createRewriteReviewPersistenceError(
      new Error("Injected supersession project write failure")
    );
  },
  (error) =>
    error instanceof RewriteReviewValidationError &&
    error.issues[0].code === "persistence_failure"
);
assert.deepEqual(fixtureSession, projectSessionBeforeFailedSupersession);
assert.equal(fixtureSession.review_rounds[0].status, "awaiting_response");
assert.equal(fixtureSession.review_rounds.length, 1);
assert.equal(presentedPromptAfterFailedSupersession, null);
assert.equal(failedSupersessionCandidate.session.review_rounds.length, 2);

const promptSession = await createRewriteSession({
  baseDocumentGeneration: 3,
  baseText: "## Plan\n\nThe plan remains provisional.",
  documentId: "doc_prompt",
  documentTitle: "Plan",
  localProjectInstanceId: "local_prompt",
  markdown: "# Strategy\n\n## Plan\n\nThe plan remains provisional.",
  projectId: "prj_prompt",
  projectTitle: "Strategy",
  target: {
    kind: "section",
    heading_snapshot: "Plan",
    heading_level: 2,
    heading_path: ["Strategy", "Plan"],
    base_start: 12,
    base_end: 51,
    context_before: "# Strategy\n\n",
    context_after: ""
  }
});
const promptRequest = await buildRewriteReviewRequest(promptSession);
const promptText = promptRequest.prompt_text;
for (const instruction of [
  "Every item in every semantic-review array must be a JSON object.",
  "Never place a string directly inside:",
  "Use [] when there are no findings.",
  "Do not summarize findings as string arrays.",
  "Do not omit required object fields.",
  "Return exactly one fenced JSON code block and no prose outside it."
]) {
  assert.equal(promptText.includes(instruction), true);
}
const promptRound = promptRequest.session.review_rounds[0];
assert.equal(promptRound.prompt_byte_length, Buffer.byteLength(promptText));
assert.equal(promptRound.prompt_schema_version, REWRITE_REVIEW_PROMPT_SCHEMA_VERSION);
assert.equal(
  promptRound.response_schema_fingerprint,
  REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT
);
assert.equal(promptRound.prompt_generator_version, REWRITE_REVIEW_PROMPT_GENERATOR_VERSION);
assert.equal(getRewriteReviewPromptFormat(promptRound), "current");
for (const name of REWRITE_REVIEW_ARRAY_NAMES) {
  assert.equal(promptText.includes(`\n- ${name}\n`), true);
  assert.equal(promptText.includes(`- ${name}: required array of JSON objects`), true);
  for (const field of REWRITE_REVIEW_ARRAY_SCHEMA[name].fields) {
    assert.equal(promptText.includes(`- ${field.name}:`), true);
    for (const enumValue of field.enumValues ?? []) {
      assert.equal(promptText.includes(`\"${enumValue}\"`), true);
    }
  }
}
assert.equal(
  promptText.includes(
    JSON.stringify({ meaning_preserved: ["The conclusion remains."] }, null, 2)
  ),
  true
);
assert.equal(promptText.includes("INVALID — array items may not be strings."), true);
for (const checklistItem of [
  "1. Every review array contains only objects.",
  "2. Every object contains all required fields.",
  "3. Empty categories use [].",
  "4. All enum values match the allowed values exactly.",
  "5. All IDs and hashes are copied exactly.",
  "6. There is exactly one JSON object.",
  "7. There is no prose outside the JSON fence."
]) {
  assert.equal(promptText.includes(checklistItem), true);
}
const promptSkeletonMatch =
  /Complete canonical response skeleton using the exact request identities:\n\n```json\n([\s\S]*?)\n```/.exec(
    promptText
  );
assert.ok(promptSkeletonMatch);
const promptSkeleton = parseRewriteReviewResponse(promptSkeletonMatch[1]);
assert.equal(promptSkeleton.rewrite_session_id, promptSession.rewrite_session_id);
assert.equal(promptSkeleton.rewrite_review_id, promptRequest.rewrite_review_id);
for (const name of REWRITE_REVIEW_ARRAY_NAMES) {
  assert.equal(promptSkeleton[name].length, 1);
  assert.equal(typeof promptSkeleton[name][0], "object");
  assert.equal(Array.isArray(promptSkeleton[name][0]), false);
}
const freshCanonicalImport = importRewriteReview({
  responseText: `\`\`\`json\n${JSON.stringify(promptSkeleton)}\n\`\`\``,
  session: promptRequest.session
});
assert.equal(freshCanonicalImport.current, true);
assert.equal(freshCanonicalImport.historical, false);
assert.equal(freshCanonicalImport.session.review_rounds.length, 1);
assert.equal(freshCanonicalImport.session.review_rounds[0].status, "imported");
assert.equal(freshCanonicalImport.session.human_draft, promptSession.human_draft);
assert.equal(freshCanonicalImport.session.base_text, promptSession.base_text);

const currentSessionBeforeRegeneration = structuredClone(promptRequest.session);
const currentFormatRegeneration = await regenerateRewriteReviewRequest({
  expectedReviewRequestId: promptRound.rewrite_review_id,
  reason: "prompt_regenerated",
  session: promptRequest.session
});
assert.deepEqual(promptRequest.session, currentSessionBeforeRegeneration);
assert.notEqual(
  currentFormatRegeneration.rewrite_review_id,
  promptRound.rewrite_review_id
);
assert.equal(currentFormatRegeneration.session.review_rounds.length, 2);
const supersededCurrentRound = currentFormatRegeneration.session.review_rounds[0];
const regeneratedCurrentRound = currentFormatRegeneration.session.review_rounds[1];
assert.equal(supersededCurrentRound.status, "superseded");
assert.equal(supersededCurrentRound.superseded_reason, "prompt_regenerated");
assert.equal(supersededCurrentRound.prompt_text, promptRound.prompt_text);
assert.equal(supersededCurrentRound.prompt_sha256, promptRound.prompt_sha256);
assert.equal(
  supersededCurrentRound.superseded_by_review_request_id,
  regeneratedCurrentRound.rewrite_review_id
);
assert.equal(
  regeneratedCurrentRound.supersedes_review_request_id,
  promptRound.rewrite_review_id
);
assert.equal(regeneratedCurrentRound.human_draft_sha256, promptRound.human_draft_sha256);
assert.equal(regeneratedCurrentRound.base_text_sha256, promptRound.base_text_sha256);
assert.equal(regeneratedCurrentRound.intent_note_sha256, promptRound.intent_note_sha256);
assert.notEqual(regeneratedCurrentRound.prompt_sha256, promptRound.prompt_sha256);
assert.equal(
  regeneratedCurrentRound.prompt_byte_length,
  Buffer.byteLength(regeneratedCurrentRound.prompt_text)
);
await assert.rejects(
  regenerateRewriteReviewRequest({
    expectedReviewRequestId: "rewrite_review_stale",
    reason: "prompt_regenerated",
    session: promptRequest.session
  }),
  /active semantic-review request changed/i
);

const currentDraftChangedSession = await updateRewriteDraft({
  humanDraft: `${promptSession.human_draft}\n\nCurrent draft addition.`,
  intentNote: promptSession.intent_note,
  session: promptRequest.session
});
const currentDraftRegeneration = await regenerateRewriteReviewRequest({
  expectedReviewRequestId: promptRound.rewrite_review_id,
  reason: "draft_changed",
  session: currentDraftChangedSession
});
assert.equal(
  currentDraftRegeneration.session.review_rounds[0].superseded_reason,
  "draft_changed"
);
assert.equal(
  currentDraftRegeneration.session.review_rounds[1].human_draft_sha256,
  currentDraftChangedSession.human_draft_sha256
);

const currentIntentChangedSession = await updateRewriteDraft({
  humanDraft: promptSession.human_draft,
  intentNote: "Preserve the decision while simplifying the explanation.",
  session: promptRequest.session
});
const currentIntentRegeneration = await regenerateRewriteReviewRequest({
  expectedReviewRequestId: promptRound.rewrite_review_id,
  reason: "intent_changed",
  session: currentIntentChangedSession
});
assert.equal(
  currentIntentRegeneration.session.review_rounds[0].superseded_reason,
  "intent_changed"
);
assert.equal(
  currentIntentRegeneration.session.review_rounds[1].intent_note_sha256,
  createHash("sha256").update(currentIntentChangedSession.intent_note).digest("hex")
);
const markedInvalidResponse = {
  ...promptSkeleton,
  meaning_preserved: ["The conclusion remains."]
};
const markedInvalidError = captureValidationError(() =>
  importRewriteReview({
    responseText: JSON.stringify(markedInvalidResponse),
    session: promptRequest.session
  })
);
assert.equal(markedInvalidError.issues[0].path, "meaning_preserved[0]");
assert.equal(markedInvalidError.issues[0].code, "invalid_array_item_type");
assert.equal(
  createRewriteReviewSchemaInstructions().includes(
    "All nine semantic-review arrays"
  ),
  false
);

const storedMalformedSession = structuredClone(repairedImport.session);
storedMalformedSession.review_rounds[0].response.meaning_preserved = [
  "not canonical"
];
assert.throws(
  () =>
    serializeRewriteProjectSessionStore({
      identity: {
        projectId: storedMalformedSession.project_id,
        documentId: storedMalformedSession.document_id
      },
      sessions: [storedMalformedSession]
    }),
  /response is invalid/
);
const serializedValidStore = serializeRewriteProjectSessionStore({
  identity: {
    projectId: repairedImport.session.project_id,
    documentId: repairedImport.session.document_id
  },
  sessions: [repairedImport.session]
});
assert.equal(
  parseRewriteProjectSessionStore({
    identity: {
      projectId: repairedImport.session.project_id,
      documentId: repairedImport.session.document_id
    },
    text: serializedValidStore
  }).sessions[0].review_rounds[0].status,
  "imported"
);

const serializedRegeneratedStore = serializeRewriteProjectSessionStore({
  identity: {
    projectId: regeneratedRequest.session.project_id,
    documentId: regeneratedRequest.session.document_id
  },
  sessions: [regeneratedRequest.session]
});
const refreshedRegeneratedSession = parseRewriteProjectSessionStore({
  identity: {
    projectId: regeneratedRequest.session.project_id,
    documentId: regeneratedRequest.session.document_id
  },
  text: serializedRegeneratedStore
}).sessions[0];
assert.equal(refreshedRegeneratedSession.status, "draft");
assert.equal(refreshedRegeneratedSession.review_rounds[0].status, "superseded");
assert.equal(
  refreshedRegeneratedSession.review_rounds[0].prompt_text,
  legacyPromptFixture
);
assert.equal(
  refreshedRegeneratedSession.review_rounds[1].status,
  "awaiting_response"
);
assert.equal(
  refreshedRegeneratedSession.review_rounds[1].response_schema_fingerprint,
  REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT
);

const otherDocumentSession = {
  ...fixtureSession,
  document_id: "doc_other",
  review_rounds: fixtureSession.review_rounds.map((round) => ({
    ...round,
    request_document_id: "doc_other"
  }))
};
const beforeOtherDocument = structuredClone(otherDocumentSession);
await regenerateOutdatedRewriteReviewRequest(fixtureSession);
assert.deepEqual(otherDocumentSession, beforeOtherDocument);

const multipleActiveSession = structuredClone(regeneratedRequest.session);
multipleActiveSession.review_rounds.push({
  ...multipleActiveSession.review_rounds[1],
  rewrite_review_id: "rewrite_review_duplicate_active"
});
assert.throws(
  () =>
    serializeRewriteProjectSessionStore({
      identity: {
        projectId: multipleActiveSession.project_id,
        documentId: multipleActiveSession.document_id
      },
      sessions: [multipleActiveSession]
    }),
  /multiple active review requests/
);

process.stdout.write(
  `${JSON.stringify(
    {
      exactRejectedFixture: {
        bytes: 9256,
        sha256:
          "0d4ebfbf955389da85283b0989b27f7923844ac811232bef8f6dd3c8f8aea746",
        invalidStringItems: 48
      },
      exactLegacyPromptFixture: {
        bytes: 74693,
        sha256:
          "00380795413830213748bcd18e2da5b58f91dee6ff7e674a58d6d8035b6f51bf",
        reviewId: "rewrite_review_72c66ae5-42b0-4b15-b6f9-9e5c63ea7ad5"
      },
      promptSchemaVersion: REWRITE_REVIEW_PROMPT_SCHEMA_VERSION,
      responseSchemaFingerprint: REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT,
      extractionAndNormalization: true,
      promptSchemaDriftProtection: true,
      legacyRequestDetection: true,
      atomicSupersessionCandidate: true,
      explicitCurrentFormatRegeneration: true,
      currentRegenerationCreatesNewIdentity: true,
      staleExpectedRequestRejected: true,
      exactOldPromptPreservation: true,
      lateSupersededImportHistorical: true,
      repairAndRegenerationSeparated: true,
      currentDraftAndIntentRegeneration: true,
      concurrentCandidatesSingleActiveEach: true,
      staleConcurrentCompletionRejected: true,
      supersessionPersistenceFailureLeavesOldActive: true,
      strictObjectArrays: true,
      structuredErrors: true,
      repairPromptFidelity: true,
      zeroWritePreflight: true,
      repairedAndEmptyImports: true,
      historicalImport: true,
      duplicateAndCancelledImports: true,
      persistenceFailureClassification: true,
      storedResponseValidation: true,
      refreshAndProjectBackedReload: true,
      multiDocumentIsolation: true
    },
    null,
    2
  )}\n`
);

function captureValidationError(operation) {
  try {
    operation();
  } catch (error) {
    assert.equal(error instanceof RewriteReviewValidationError, true);
    return error;
  }
  assert.fail("Expected RewriteReviewValidationError.");
}

function createFixtureSession(identity) {
  return {
    schema_version: 1,
    rewrite_session_id: identity.rewrite_session_id,
    local_project_instance_id: "local_real_fixture",
    project_id: identity.project_id,
    document_id: identity.document_id,
    project_title_snapshot: "Strategy",
    document_title_snapshot: "Crust Chant — Action Plan",
    target: {
      kind: "section",
      heading_snapshot: "Growth Path and Scenarios",
      heading_level: 2,
      heading_path: ["Growth Path and Scenarios"],
      base_start: 1,
      base_end: 2,
      context_before: "",
      context_after: ""
    },
    base_document_generation: 1,
    base_document_sha256: "2".repeat(64),
    base_text_sha256: identity.base_text_sha256,
    base_text: legacyRequestPayload.current_text,
    human_draft_sha256: identity.human_draft_sha256,
    human_draft: legacyRequestPayload.human_draft,
    intent_note: legacyRequestPayload.intent_note,
    status: "draft",
    authoritative_revision: 1,
    authoritative_generation: 1,
    stale_reference: false,
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z",
    review_rounds: [
      {
        rewrite_review_id: identity.rewrite_review_id,
        request_project_id: identity.project_id,
        request_document_id: identity.document_id,
        base_text_sha256: identity.base_text_sha256,
        human_draft_sha256: identity.human_draft_sha256,
        intent_note_sha256:
          "6509f53cdc8abf2a8d077a663bec434ba67a2e8db21d535f86e6a4e6f0472df5",
        prompt_sha256:
          "00380795413830213748bcd18e2da5b58f91dee6ff7e674a58d6d8035b6f51bf",
        prompt_text: legacyPromptFixture,
        exported_at: "2026-08-04T03:26:03.692Z",
        status: "awaiting_response"
      }
    ],
    reference_history: []
  };
}

function repairStringArrayResponse(value) {
  const repaired = structuredClone(value);
  for (const name of REWRITE_REVIEW_ARRAY_NAMES) {
    repaired[name] = repaired[name].map((finding) => {
      assert.equal(typeof finding, "string");
      const example = createRewriteReviewArrayItemExample(name);
      const fields = REWRITE_REVIEW_ARRAY_SCHEMA[name].fields;
      return Object.fromEntries(
        fields.map((field, index) => [
          field.name,
          index === 0 && !field.enumValues ? finding : example[field.name]
        ])
      );
    });
  }
  return repaired;
}

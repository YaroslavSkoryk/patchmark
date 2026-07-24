import {
  REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION,
  type PatchmarkReviewResponseAnalysis,
  type ReviewResponseCommentOutcome
} from "./review-batch-types.ts";

export function normalizeReviewResponseAnalysis({
  batchId,
  documentId,
  importId,
  orderedCommentIds,
  projectId,
  value
}: {
  batchId: string;
  documentId: string;
  importId: string | null;
  orderedCommentIds: string[];
  projectId: string;
  value: unknown;
}): PatchmarkReviewResponseAnalysis | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schema_version !== REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION ||
    value.review_batch_id !== batchId ||
    value.project_id !== projectId ||
    value.document_id !== documentId ||
    typeof value.import_id !== "string" ||
    value.import_id.length === 0 ||
    value.import_id !== importId ||
    (value.coverage_status !== "complete" &&
      value.coverage_status !== "partial") ||
    typeof value.analyzed_at !== "string" ||
    value.analyzed_at.length === 0 ||
    !Array.isArray(value.ordered_comment_outcomes) ||
    value.ordered_comment_outcomes.length !== orderedCommentIds.length
  ) {
    throw invalidAnalysis();
  }

  const outcomes = value.ordered_comment_outcomes.map((candidate, index) =>
    normalizeOutcome(candidate, orderedCommentIds[index])
  );
  const aggregate = normalizeAggregate(value.aggregate);
  const expectedAggregate = createExpectedAggregate(outcomes);
  if (
    !sameAggregate(aggregate, expectedAggregate) ||
    value.coverage_status !==
      (expectedAggregate.unanswered_comments === 0 ? "complete" : "partial")
  ) {
    throw invalidAnalysis();
  }

  return {
    schema_version: REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION,
    review_batch_id: batchId,
    project_id: projectId,
    document_id: documentId,
    import_id: value.import_id,
    coverage_status: value.coverage_status,
    analyzed_at: value.analyzed_at,
    ordered_comment_outcomes: outcomes,
    aggregate
  };
}

function normalizeOutcome(
  value: unknown,
  expectedCommentId: string
): ReviewResponseCommentOutcome {
  if (
    !isRecord(value) ||
    value.comment_id !== expectedCommentId ||
    typeof value.addressed !== "boolean"
  ) {
    throw invalidAnalysis();
  }
  const replyIds = normalizeUniqueIds(value.reply_ids);
  const patchIds = normalizeUniqueIds(value.patch_ids);
  const clarificationIds = normalizeUniqueIds(value.clarification_ids);
  const explicitNoChangeIds = normalizeUniqueIds(
    value.explicit_no_change_ids
  );
  const counts = [
    value.reply_count,
    value.patch_count,
    value.clarification_count,
    value.explicit_no_change_count
  ];
  if (
    !counts.every(isNonNegativeInteger) ||
    value.reply_count !== replyIds.length ||
    value.patch_count !== patchIds.length ||
    value.clarification_count !== clarificationIds.length ||
    value.explicit_no_change_count !== explicitNoChangeIds.length
  ) {
    throw invalidAnalysis();
  }
  const addressed =
    replyIds.length +
      patchIds.length +
      clarificationIds.length +
      explicitNoChangeIds.length >
    0;
  if (value.addressed !== addressed) {
    throw invalidAnalysis();
  }
  return {
    comment_id: expectedCommentId,
    addressed,
    reply_ids: replyIds,
    patch_ids: patchIds,
    clarification_ids: clarificationIds,
    explicit_no_change_ids: explicitNoChangeIds,
    reply_count: replyIds.length,
    patch_count: patchIds.length,
    clarification_count: clarificationIds.length,
    explicit_no_change_count: explicitNoChangeIds.length
  };
}

function normalizeAggregate(
  value: unknown
): PatchmarkReviewResponseAnalysis["aggregate"] {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.expected_comments) ||
    !isNonNegativeInteger(value.addressed_comments) ||
    !isNonNegativeInteger(value.unanswered_comments) ||
    !isNonNegativeInteger(value.replies_added) ||
    !isNonNegativeInteger(value.patch_proposals_added) ||
    !isNonNegativeInteger(value.clarification_questions) ||
    !isNonNegativeInteger(value.explicit_no_change_responses)
  ) {
    throw invalidAnalysis();
  }
  return {
    expected_comments: value.expected_comments,
    addressed_comments: value.addressed_comments,
    unanswered_comments: value.unanswered_comments,
    replies_added: value.replies_added,
    patch_proposals_added: value.patch_proposals_added,
    clarification_questions: value.clarification_questions,
    explicit_no_change_responses: value.explicit_no_change_responses
  };
}

function createExpectedAggregate(
  outcomes: ReviewResponseCommentOutcome[]
): PatchmarkReviewResponseAnalysis["aggregate"] {
  const addressedComments = outcomes.filter(
    (outcome) => outcome.addressed
  ).length;
  return {
    expected_comments: outcomes.length,
    addressed_comments: addressedComments,
    unanswered_comments: outcomes.length - addressedComments,
    replies_added: sum(outcomes, "reply_count"),
    patch_proposals_added: sum(outcomes, "patch_count"),
    clarification_questions: sum(outcomes, "clarification_count"),
    explicit_no_change_responses: sum(
      outcomes,
      "explicit_no_change_count"
    )
  };
}

function normalizeUniqueIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw invalidAnalysis();
  }
  return [...value] as string[];
}

function sameAggregate(
  left: PatchmarkReviewResponseAnalysis["aggregate"],
  right: PatchmarkReviewResponseAnalysis["aggregate"]
): boolean {
  return (
    left.expected_comments === right.expected_comments &&
    left.addressed_comments === right.addressed_comments &&
    left.unanswered_comments === right.unanswered_comments &&
    left.replies_added === right.replies_added &&
    left.patch_proposals_added === right.patch_proposals_added &&
    left.clarification_questions === right.clarification_questions &&
    left.explicit_no_change_responses ===
      right.explicit_no_change_responses
  );
}

function sum(
  outcomes: ReviewResponseCommentOutcome[],
  key:
    | "reply_count"
    | "patch_count"
    | "clarification_count"
    | "explicit_no_change_count"
): number {
  return outcomes.reduce((total, outcome) => total + outcome[key], 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidAnalysis(): Error {
  return new Error("Review Batch response analysis is invalid.");
}

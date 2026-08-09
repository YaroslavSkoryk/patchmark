import type { RewriteSemanticReviewResponse } from "./rewrite-session-types.ts";

export const REWRITE_REVIEW_IMPORT_PROTOCOL =
  "patchmark.human_rewrite_review_import" as const;
export const REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION = 1 as const;
export const REWRITE_REVIEW_PROMPT_SCHEMA_VERSION = 2 as const;
export const REWRITE_REVIEW_PROMPT_GENERATOR_VERSION =
  "patchmark.human_rewrite_review_prompt.v2" as const;
export const REWRITE_REVIEW_OVERALL_ASSESSMENTS = [
  "meaning_preserved",
  "review_recommended",
  "substantial_change",
  "unclear"
] as const;

export type RewriteReviewArrayName =
  | "meaning_preserved"
  | "meaning_changed"
  | "omitted_points"
  | "new_claims"
  | "contradictions"
  | "certainty_changes"
  | "source_impacts"
  | "ambiguities"
  | "suggested_draft_edits";

export type RewriteReviewValidationIssueCode =
  | "invalid_array_item_type"
  | "missing_required_field"
  | "invalid_enum"
  | "identity_mismatch"
  | "hash_mismatch"
  | "duplicate_review_import"
  | "multiple_json_values"
  | "invalid_json"
  | "invalid_type"
  | "missing_required_array"
  | "unexpected_text_outside_json"
  | "review_request_not_found"
  | "cancelled_review_request"
  | "persistence_failure";

export type RewriteReviewValidationIssue = {
  path: string;
  code: RewriteReviewValidationIssueCode;
  expected: string;
  actualType?: string;
  actualValue?: string | number | boolean | null;
  message: string;
  example?: unknown;
};

export type RewriteReviewErrorCategory =
  | "response_shape"
  | "identity"
  | "lifecycle"
  | "persistence";

export class RewriteReviewValidationError extends Error {
  readonly category: RewriteReviewErrorCategory;
  readonly guidance: string;
  readonly issues: RewriteReviewValidationIssue[];
  readonly repairPromptEligible: boolean;
  readonly reviewRequestId?: string;
  readonly reviewRequestStatus?: "awaiting_response" | "cancelled" | "imported" | "superseded";

  constructor({
    category,
    guidance,
    issues,
    message,
    repairPromptEligible,
    reviewRequestId,
    reviewRequestStatus
  }: {
    category: RewriteReviewErrorCategory;
    guidance: string;
    issues: RewriteReviewValidationIssue[];
    message?: string;
    repairPromptEligible: boolean;
    reviewRequestId?: string;
    reviewRequestStatus?: "awaiting_response" | "cancelled" | "imported" | "superseded";
  }) {
    super(message ?? issues[0]?.message ?? "The semantic review response is invalid.");
    this.name = "RewriteReviewValidationError";
    this.category = category;
    this.guidance = guidance;
    this.issues = issues;
    this.repairPromptEligible = repairPromptEligible;
    this.reviewRequestId = reviewRequestId;
    this.reviewRequestStatus = reviewRequestStatus;
  }
}

type RewriteReviewItemFieldSchema = {
  name: string;
  allowEmpty: boolean;
  description: string;
  enumValues?: readonly string[];
  example: string;
};

type RewriteReviewArraySchema = {
  description: string;
  fields: readonly RewriteReviewItemFieldSchema[];
};

const SEVERITIES = ["low", "medium", "high"] as const;

export const REWRITE_REVIEW_ARRAY_SCHEMA: Record<
  RewriteReviewArrayName,
  RewriteReviewArraySchema
> = {
  meaning_preserved: {
    description: "Meaning from the current text that the Human Draft retains.",
    fields: [
      {
        name: "point",
        allowEmpty: false,
        description: "Preserved semantic point.",
        example: "The launch remains conditional on repeat demand."
      },
      {
        name: "current_text_evidence",
        allowEmpty: true,
        description: "Evidence excerpt from the supplied current text; the field is required but may be empty.",
        example: "depends on repeat demand"
      },
      {
        name: "rewrite_evidence",
        allowEmpty: true,
        description: "Corresponding evidence from the Human Draft; the field is required but may be empty.",
        example: "growth remains conditional on repeat demand"
      }
    ]
  },
  meaning_changed: {
    description: "Meaning that differs between the current text and Human Draft.",
    fields: [
      {
        name: "topic",
        allowEmpty: false,
        description: "Topic whose meaning changed.",
        example: "Launch certainty"
      },
      {
        name: "current_meaning",
        allowEmpty: true,
        description: "Meaning in the supplied current text; the field is required but may be empty.",
        example: "The plan is provisional."
      },
      {
        name: "rewrite_meaning",
        allowEmpty: true,
        description: "Meaning in the Human Draft; the field is required but may be empty.",
        example: "The plan is deliberately cautious."
      },
      {
        name: "assessment",
        allowEmpty: false,
        description: "Whether the change appears intentional.",
        enumValues: ["deliberate", "possibly_unintentional", "unclear"],
        example: "possibly_unintentional"
      },
      {
        name: "severity",
        allowEmpty: false,
        description: "Semantic significance of the change.",
        enumValues: SEVERITIES,
        example: "medium"
      }
    ]
  },
  omitted_points: {
    description: "Important current-text points omitted from the Human Draft.",
    fields: [
      {
        name: "point",
        allowEmpty: false,
        description: "Omitted semantic point.",
        example: "Wholesale samples remain limited."
      },
      {
        name: "importance",
        allowEmpty: false,
        description: "Importance of the omitted point.",
        enumValues: SEVERITIES,
        example: "high"
      },
      {
        name: "reason",
        allowEmpty: true,
        description: "Why the omission matters; the field is required but may be empty.",
        example: "It qualifies the launch scope."
      }
    ]
  },
  new_claims: {
    description: "Claims introduced by the Human Draft relative to the current text.",
    fields: [
      {
        name: "claim",
        allowEmpty: false,
        description: "New or expanded claim.",
        example: "Three production cycles will be sufficient."
      },
      {
        name: "relative_support",
        allowEmpty: false,
        description: "How directly the supplied current text supports the claim.",
        enumValues: [
          "present_in_current_text",
          "partially_present_in_current_text",
          "not_present_in_current_text"
        ],
        example: "not_present_in_current_text"
      },
      {
        name: "note",
        allowEmpty: true,
        description: "Support note; the field is required but may be empty.",
        example: "The current text does not establish this capacity."
      }
    ]
  },
  contradictions: {
    description: "Internal contradictions introduced or exposed by the Human Draft.",
    fields: [
      {
        name: "issue",
        allowEmpty: false,
        description: "Contradictory statements or implications.",
        example: "The draft calls the same capacity both sufficient and constrained."
      },
      {
        name: "severity",
        allowEmpty: false,
        description: "Significance of the contradiction.",
        enumValues: SEVERITIES,
        example: "high"
      }
    ]
  },
  certainty_changes: {
    description: "Statements whose confidence, qualification, or certainty changed.",
    fields: [
      {
        name: "topic",
        allowEmpty: false,
        description: "Topic whose certainty changed.",
        example: "Demand forecast"
      },
      {
        name: "from",
        allowEmpty: false,
        description: "Current-text certainty.",
        example: "provisional"
      },
      {
        name: "to",
        allowEmpty: false,
        description: "Human Draft certainty.",
        example: "expected"
      },
      {
        name: "impact",
        allowEmpty: true,
        description: "Semantic impact; the field is required but may be empty.",
        example: "The draft sounds more confident."
      }
    ]
  },
  source_impacts: {
    description: "Changes to citations, source markers, or source support.",
    fields: [
      {
        name: "claim_or_source",
        allowEmpty: false,
        description: "Affected claim or source marker.",
        example: "Capacity estimate [S1]"
      },
      {
        name: "impact",
        allowEmpty: false,
        description: "Kind of source impact.",
        enumValues: [
          "citation_added",
          "citation_changed",
          "citation_removed",
          "source_support_changed",
          "none"
        ],
        example: "source_support_changed"
      },
      {
        name: "note",
        allowEmpty: true,
        description: "Source-impact explanation; the field is required but may be empty.",
        example: "The rewrite broadens the claim beyond the cited evidence."
      }
    ]
  },
  ambiguities: {
    description: "Ambiguities in the Human Draft that merit human review.",
    fields: [
      {
        name: "issue",
        allowEmpty: false,
        description: "Ambiguous wording or implication.",
        example: "It is unclear which stage the gate applies to."
      },
      {
        name: "suggestion",
        allowEmpty: true,
        description: "Clarification suggestion; the field is required but may be empty.",
        example: "Name the stage explicitly."
      }
    ]
  },
  suggested_draft_edits: {
    description: "Targeted suggestions for the human-authored draft.",
    fields: [
      {
        name: "draft_excerpt",
        allowEmpty: false,
        description: "Exact or readily locatable Human Draft excerpt.",
        example: "the plan will work"
      },
      {
        name: "suggested_text",
        allowEmpty: false,
        description: "Suggested replacement text for human consideration.",
        example: "the plan is expected to work if repeat demand is sustained"
      },
      {
        name: "reason",
        allowEmpty: true,
        description: "Reason for the suggestion; the field is required but may be empty.",
        example: "Restores the original qualification."
      }
    ]
  }
};

export const REWRITE_REVIEW_ARRAY_NAMES = Object.keys(
  REWRITE_REVIEW_ARRAY_SCHEMA
) as RewriteReviewArrayName[];

export const REWRITE_REVIEW_RESPONSE_SCHEMA_DESCRIPTOR = {
  schema_descriptor_version: 1,
  type: "object",
  required_fields: {
    protocol: {
      type: "string",
      const: REWRITE_REVIEW_IMPORT_PROTOCOL
    },
    protocol_version: {
      type: "integer",
      const: REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION
    },
    rewrite_session_id: { type: "string", required: true, allow_empty: false },
    rewrite_review_id: { type: "string", required: true, allow_empty: false },
    project_id: { type: "string", required: true, allow_empty: false },
    document_id: { type: "string", required: true, allow_empty: false },
    base_text_sha256: { type: "string", required: true, format: "sha256" },
    human_draft_sha256: { type: "string", required: true, format: "sha256" },
    overall_assessment: {
      type: "string",
      required: true,
      enum: REWRITE_REVIEW_OVERALL_ASSESSMENTS
    },
    summary: { type: "string", required: true, allow_empty: true },
    ...Object.fromEntries(
      REWRITE_REVIEW_ARRAY_NAMES.map((name) => [
        name,
        {
          type: "array",
          required: true,
          allow_empty: true,
          item_type: "object",
          item_required_fields: Object.fromEntries(
            REWRITE_REVIEW_ARRAY_SCHEMA[name].fields.map((field) => [
              field.name,
              {
                type: "string",
                required: true,
                allow_empty: field.allowEmpty,
                ...(field.enumValues ? { enum: field.enumValues } : {})
              }
            ])
          )
        }
      ])
    )
  }
} as const;

export const REWRITE_REVIEW_RESPONSE_SCHEMA_SERIALIZATION = JSON.stringify(
  REWRITE_REVIEW_RESPONSE_SCHEMA_DESCRIPTOR
);

export const REWRITE_REVIEW_RESPONSE_SCHEMA_FINGERPRINT =
  "sha256:68459130b7a42180c9c27a8a16a566576b7f5f6c23267eb67bc2b5f4d6ead32f" as const;

export type RewriteReviewResponseIdentity = {
  rewrite_session_id: string;
  rewrite_review_id: string;
  project_id: string;
  document_id: string;
  base_text_sha256: string;
  human_draft_sha256: string;
};

export function createRewriteReviewResponseSkeleton(
  identity: RewriteReviewResponseIdentity
): RewriteSemanticReviewResponse {
  return {
    protocol: REWRITE_REVIEW_IMPORT_PROTOCOL,
    protocol_version: REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION,
    ...identity,
    overall_assessment: "review_recommended",
    summary: "Summarize the semantic comparison for the human author.",
    ...Object.fromEntries(
      REWRITE_REVIEW_ARRAY_NAMES.map((name) => [
        name,
        [createRewriteReviewArrayItemExample(name)]
      ])
    )
  } as RewriteSemanticReviewResponse;
}

export function createRewriteReviewArrayItemExample(
  name: RewriteReviewArrayName
): Record<string, string> {
  return Object.fromEntries(
    REWRITE_REVIEW_ARRAY_SCHEMA[name].fields.map((field) => [
      field.name,
      field.example
    ])
  );
}

export function createRewriteReviewSchemaInstructions(): string {
  return REWRITE_REVIEW_ARRAY_NAMES.map((name) => {
    const schema = REWRITE_REVIEW_ARRAY_SCHEMA[name];
    const fields = schema.fields
      .map((field) => {
        const values = field.enumValues
          ? ` Allowed values: ${field.enumValues.map((value) => `\"${value}\"`).join(", ")}.`
          : "";
        const empty = field.allowEmpty
          ? " The field is required; an empty string is accepted."
          : " The field is required and must be a non-empty string.";
        return `  - ${field.name}: ${field.description}${empty}${values}`;
      })
      .join("\n");
    return `- ${name}: required array of JSON objects; an empty array is allowed. ${schema.description}\n${fields}`;
  }).join("\n");
}

export function parseRewriteReviewJsonValue(responseText: string): unknown {
  const withoutBom = responseText.replace(/^\uFEFF/, "");
  const trimmed = withoutBom.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fences.length > 1) {
    throw responseShapeError({
      path: "$",
      code: "multiple_json_values",
      expected: "exactly one JSON value",
      actualType: "multiple fenced blocks",
      message: "The response contains multiple fenced JSON blocks."
    });
  }
  let jsonText = trimmed;
  if (fences.length === 1) {
    const fence = fences[0];
    const before = trimmed.slice(0, fence.index);
    const after = trimmed.slice((fence.index ?? 0) + fence[0].length);
    if (before.trim() || after.trim()) {
      throw responseShapeError({
        path: "$",
        code: "unexpected_text_outside_json",
        expected: "one fenced JSON block with no surrounding prose",
        actualType: "text outside JSON fence",
        message: "Remove explanatory text outside the single JSON block."
      });
    }
    jsonText = fence[1].trim();
  }
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    const parserMessage = error instanceof Error ? error.message : String(error);
    throw responseShapeError({
      path: "$",
      code: "invalid_json",
      expected: "valid JSON",
      actualType: "invalid JSON syntax",
      message: `The response is not valid JSON: ${parserMessage}`
    });
  }
}

export function validateRewriteReviewResponseIdentity(
  value: unknown
): RewriteReviewResponseIdentity {
  if (!isRecord(value)) {
    throw responseShapeError({
      path: "$",
      code: "invalid_type",
      expected: "JSON object",
      actualType: describeType(value),
      message: `The semantic review response must be a JSON object, not ${describeType(value)}.`
    });
  }
  const issues: RewriteReviewValidationIssue[] = [];
  validateExactIdentityValue(
    value,
    "protocol",
    REWRITE_REVIEW_IMPORT_PROTOCOL,
    issues
  );
  validateExactIdentityValue(
    value,
    "protocol_version",
    REWRITE_REVIEW_IMPORT_PROTOCOL_VERSION,
    issues
  );
  const identityKeys = [
    "rewrite_session_id",
    "rewrite_review_id",
    "project_id",
    "document_id"
  ] as const;
  identityKeys.forEach((key) => validateIdentityString(value, key, issues));
  const hashKeys = ["base_text_sha256", "human_draft_sha256"] as const;
  hashKeys.forEach((key) => validateIdentityHash(value, key, issues));
  if (issues.length > 0) {
    throw new RewriteReviewValidationError({
      category: "identity",
      guidance: "Use the response created for this exact exported review request, or export a fresh request.",
      issues,
      message: "The response does not contain valid Patchmark review identity.",
      repairPromptEligible: false
    });
  }
  return {
    rewrite_session_id: value.rewrite_session_id as string,
    rewrite_review_id: value.rewrite_review_id as string,
    project_id: value.project_id as string,
    document_id: value.document_id as string,
    base_text_sha256: value.base_text_sha256 as string,
    human_draft_sha256: value.human_draft_sha256 as string
  };
}

export function validateRewriteReviewResponseValue(
  value: unknown
): RewriteSemanticReviewResponse {
  validateRewriteReviewResponseIdentity(value);
  const record = value as Record<string, unknown>;
  const issues: RewriteReviewValidationIssue[] = [];
  validateEnumField(
    record,
    "overall_assessment",
    REWRITE_REVIEW_OVERALL_ASSESSMENTS,
    issues
  );
  validateStringField(record, "summary", true, issues);
  REWRITE_REVIEW_ARRAY_NAMES.forEach((name) => {
    const array = record[name];
    const itemExample = createRewriteReviewArrayItemExample(name);
    if (array === undefined) {
      issues.push({
        path: name,
        code: "missing_required_array",
        expected: "array of objects; use [] when there are no findings",
        actualType: "missing",
        message: `${name} is required. Use an empty array when there are no findings.`,
        example: []
      });
      return;
    }
    if (!Array.isArray(array)) {
      issues.push({
        path: name,
        code: "invalid_type",
        expected: "array of objects",
        actualType: describeType(array),
        message: `${name} must be an array of objects.`,
        example: [itemExample]
      });
      return;
    }
    array.forEach((item, index) => {
      const itemPath = `${name}[${index}]`;
      if (!isRecord(item)) {
        issues.push({
          path: itemPath,
          code: "invalid_array_item_type",
          expected: `object with fields: ${REWRITE_REVIEW_ARRAY_SCHEMA[name].fields.map((field) => field.name).join(", ")}`,
          actualType: describeType(item),
          actualValue: toDisplayValue(item),
          message: `${itemPath} must be an object, but received ${describeType(item)}.`,
          example: itemExample
        });
        return;
      }
      REWRITE_REVIEW_ARRAY_SCHEMA[name].fields.forEach((field) => {
        const path = `${itemPath}.${field.name}`;
        if (!(field.name in item)) {
          issues.push({
            path,
            code: "missing_required_field",
            expected: field.enumValues
              ? `required string; one of: ${field.enumValues.join(", ")}`
              : field.allowEmpty
                ? "required string; empty is allowed"
                : "required non-empty string",
            actualType: "missing",
            message: `${path} is required.`,
            example: field.example
          });
          return;
        }
        if (field.enumValues) {
          validateEnumField(item, field.name, field.enumValues, issues, path);
        } else {
          validateStringField(item, field.name, field.allowEmpty, issues, path);
        }
      });
    });
  });
  if (issues.length > 0) {
    throw new RewriteReviewValidationError({
      category: "response_shape",
      guidance: "Copy the repair prompt, ask ChatGPT to repair structure only, then paste the repaired JSON here.",
      issues,
      message: `${issues.length} semantic-review validation problem${issues.length === 1 ? "" : "s"} found.`,
      repairPromptEligible: true
    });
  }
  return value as RewriteSemanticReviewResponse;
}

function validateExactIdentityValue(
  record: Record<string, unknown>,
  key: string,
  expected: string | number,
  issues: RewriteReviewValidationIssue[]
): void {
  if (record[key] !== expected) {
    issues.push({
      path: key,
      code: "identity_mismatch",
      expected: JSON.stringify(expected),
      actualType: describeType(record[key]),
      actualValue: toDisplayValue(record[key]),
      message: `${key} must be ${JSON.stringify(expected)}.`
    });
  }
}

function validateIdentityString(
  record: Record<string, unknown>,
  key: string,
  issues: RewriteReviewValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    issues.push({
      path: key,
      code: "identity_mismatch",
      expected: "exact non-empty identity copied from the request",
      actualType: describeType(value),
      actualValue: toDisplayValue(value),
      message: `${key} must be the exact non-empty value from the exported request.`
    });
  }
}

function validateIdentityHash(
  record: Record<string, unknown>,
  key: string,
  issues: RewriteReviewValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    issues.push({
      path: key,
      code: "hash_mismatch",
      expected: "exact 64-character SHA-256 copied from the request",
      actualType: describeType(value),
      actualValue: toDisplayValue(value),
      message: `${key} must be the exact SHA-256 fingerprint from the exported request.`
    });
  }
}

function validateStringField(
  record: Record<string, unknown>,
  key: string,
  allowEmpty: boolean,
  issues: RewriteReviewValidationIssue[],
  path = key
): void {
  const value = record[key];
  if (value === undefined) {
    issues.push({
      path,
      code: "missing_required_field",
      expected: allowEmpty ? "required string; empty is allowed" : "required non-empty string",
      actualType: "missing",
      message: `${path} is required.`
    });
    return;
  }
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    issues.push({
      path,
      code: "invalid_type",
      expected: allowEmpty ? "string; empty is allowed" : "non-empty string",
      actualType: describeType(value),
      actualValue: toDisplayValue(value),
      message: `${path} must be ${allowEmpty ? "a string" : "a non-empty string"}.`
    });
  }
}

function validateEnumField(
  record: Record<string, unknown>,
  key: string,
  values: readonly string[],
  issues: RewriteReviewValidationIssue[],
  path = key
): void {
  const value = record[key];
  if (value === undefined) {
    issues.push({
      path,
      code: "missing_required_field",
      expected: `required string; one of: ${values.join(", ")}`,
      actualType: "missing",
      message: `${path} is required.`
    });
    return;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    issues.push({
      path,
      code: "invalid_enum",
      expected: `one of: ${values.join(", ")}`,
      actualType: describeType(value),
      actualValue: toDisplayValue(value),
      message: `${path} must be one of: ${values.join(", ")}.`
    });
  }
}

function responseShapeError(
  issue: RewriteReviewValidationIssue
): RewriteReviewValidationError {
  return new RewriteReviewValidationError({
    category: "response_shape",
    guidance: "Copy the repair prompt, ask ChatGPT to repair structure only, then paste the repaired JSON here.",
    issues: [issue],
    repairPromptEligible: true
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function describeType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function toDisplayValue(
  value: unknown
): string | number | boolean | null | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : undefined;
}

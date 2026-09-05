import type {
  PatchmarkCommentReplyImport,
  PatchmarkExternalComment,
  PatchmarkExternalCommentAnchor,
  PatchmarkExternalParticipantResponse,
  PatchmarkExternalPatchProposal,
  PatchmarkLegacyCommentReplyImport,
  PatchmarkLegacyPatchProposal,
  PatchmarkResponseCommentTarget,
  PatchmarkSelectedTextAnchorContext,
  PatchmarkSourceReference,
  PatchmarkSuggestedUserAction
} from "../project/project-types.ts";
import { containsReservedPatchmarkTableMarker } from "../patches/atomic-table-patches.ts";
import {
  PatchDependencyValidationError,
  validatePatchDependencyGraph
} from "../patches/patch-dependencies.ts";
import { normalizePatchDisplayTitleCandidate } from "../patches/patch-display-title.ts";
import {
  SourceReferenceValidationError,
  normalizeSourceDateField,
  validateConsistentRepeatedSourceDates,
  validateSourceDateOrder,
  validateSuggestedTextReferenceDates
} from "./source-date-validation.ts";

export const CHATGPT_IMPORT_REPAIR_PROMPT = `Please repair your previous response into exactly one fenced json code block containing valid Patchmark JSON.

Do not change the substance of the reply or patch.

Use one opening \`\`\`json fence.
Use one closing \`\`\` fence.
Do not include text before the opening fence.
Do not include text after the closing fence.
Do not use footnotes or reference links.

Source rules:
- Every \`url\` must be a raw URL string starting with \`https://\` or \`http://\`.
- Every source object must include \`published_at\` and \`observed_at\`.
- Use \`published_at: null\` when the source publication date is unavailable; never guess.
- \`observed_at\` must be the complete YYYY-MM-DD date when the source was accessed or verified.
- Do not use Markdown links in metadata or source fields.
- Do not include \`[\`, \`]\`, \`(\`, or \`)\` around URLs.
- Do not include quotes, escaped quotes, or backslashes in URLs.
- Put all URLs only inside field-local source arrays.
- \`supports\` must be plain text only.
- Markdown links are allowed only in document Markdown fields: \`original_text\` and \`suggested_text\`.
- Any new Markdown link in \`suggested_text\` must visibly include a publication date or the phrase \`publication date unavailable\`; dynamic facts must also include an observation date.`;

export const CHATGPT_DEPENDENCY_REPAIR_PROMPT_RULES = `Dependency rules:
- Use \`protocol_version: 2\` when returning patch dependencies.
- Every protocol-v2 patch proposal must include a unique non-empty \`patch_key\`.
- Every protocol-v2 patch proposal must include \`depends_on\`; use an empty array for an independent patch.
- Each \`depends_on\` entry must reference a \`patch_key\` in this same response and for the same \`comment_id\`.
- Do not create self-dependencies, duplicate dependency entries, or cycles.
- Declare every prerequisite needed to make a later patch valid, including visible source-date disclosures and inline-source preservation before source-section deletion.
- Dependencies control validation and review order only. Do not claim that Patchmark will accept prerequisites automatically.`;

export const CHATGPT_INTERNAL_CITATION_PROMPT_RULES = `Internal citation artifact rules:

- \`summary\` must be plain text without citations, URLs, Markdown links, footnotes, or citation markers.
- Never output ChatGPT, OpenAI, or other platform-internal citation syntax anywhere in the JSON.
- Forbidden examples include, but are not limited to:
  - \`:contentReference[...]\`
  - \`oaicite\`
  - \`turn0search0\`, \`turn1view0\`, or similar internal identifiers when used as citations
  - private platform citation tokens such as internal cite/filecite markers
- These markers are not valid Patchmark sources.
- All evidence must use Patchmark's field-local source arrays: \`reply_sources\`, \`suggested_text_sources\`, \`reason_sources\`, \`risk_sources\`, and \`question_sources\`.
- References that must remain visible in the resulting document must use normal Markdown links inside \`original_text\` or \`suggested_text\`.
- Before returning the response, scan every JSON string and remove any internal citation syntax. If a source is necessary, represent it through the appropriate Patchmark source object instead.`;

const STRICT_CHATGPT_IMPORT_ERROR =
  "Invalid Patchmark response. Metadata references must be inside field-local sources arrays. Markdown links are allowed only in original_text and suggested_text.";
const INVALID_CHATGPT_JSON_ERROR =
  "Invalid JSON. Ask ChatGPT to return one fenced json code block containing valid Patchmark JSON.";
const RESERVED_PATCHMARK_TABLE_MARKER_ERROR =
  "Invalid Patchmark response. Patch text must not include Patchmark table context markers.";
const PROTOCOL_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const PROTOCOL_MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/;
const PROTOCOL_BROKEN_MARKDOWN_LINK_PATTERN = /\]\(/;
const PROTOCOL_REFERENCE_LINK_PATTERN = /\[[^\]]+\]\[[^\]]+\]|\[\d+\]/;
const PROTOCOL_FOOTNOTE_PATTERN = /\[\^[^\]]+\]/;
const SOURCE_URL_MARKDOWN_PATTERN = /[\[\]\(\)"\\]/;
const CONTENT_REFERENCE_PATTERN =
  /:contentReference\[[^\]]*\](?:\{[^}]*\})?/gi;
const PRIVATE_USE_CITATION_PATTERN =
  /\uE200(?:cite|filecite|navlist|news|finance|weather)?\uE202[^\uE201]*\uE201/g;
const BRACKETED_INTERNAL_CITATION_PATTERN =
  /【[^】]*(?:oaicite:\d+|turn\d+(?:search|view|fetch|file|news|image|finance|weather)\d+)[^】]*】/gi;
const OAICITE_REFERENCE_PATTERN = /\[oaicite:\d+\](?:\{index=\d+\})?/gi;
const OAICITE_TOKEN_PATTERN = /\boaicite(?::\d+)?\b/gi;
const INTERNAL_TURN_ID_PATTERN =
  /\bturn\d+(?:search|view|fetch|file|news|image|finance|weather)\d+\b/gi;
const DOCUMENT_MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(https?:\/\/[^)]+\)/gi;
const RAW_URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const RESPONSE_LOCAL_COMMENT_REF_PATTERN = /^[a-z][a-z0-9_-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const PATCHMARK_EXTERNAL_RESPONSE_LIMITS = Object.freeze({
  maximum_array_items: 100,
  maximum_body_length: 32 * 1024,
  maximum_context_length: 64 * 1024,
  maximum_heading_length: 1024,
  maximum_heading_path_items: 32,
  maximum_identity_length: 256,
  maximum_local_ref_length: 64,
  maximum_offset: 2_147_483_647,
  maximum_response_bytes: 8 * 1024 * 1024,
  maximum_selected_text_length: 32 * 1024,
  maximum_short_text_length: 1024,
  maximum_sources_per_field: 32
});

type JsonPathPart = string | number;

type CitationNormalizationResult = {
  changedStringPaths: Set<string>;
  value: unknown;
};

export function parsePatchmarkCommentReplyImport(
  rawInput: string
): PatchmarkCommentReplyImport {
  let parsedResponse: unknown;

  try {
    parsedResponse = JSON.parse(stripMarkdownJsonFence(rawInput));
  } catch {
    throw new Error(INVALID_CHATGPT_JSON_ERROR);
  }

  const normalization = normalizeInternalCitationArtifactsInJsonValue(
    parsedResponse
  );
  parsedResponse = normalization.value;

  if (!isRecord(parsedResponse)) {
    throw new Error("Invalid Patchmark response. Expected a JSON object.");
  }

  if (parsedResponse.protocol !== "patchmark.comment_reply_import") {
    throw new Error(
      "Invalid Patchmark response. Expected protocol `patchmark.comment_reply_import`."
    );
  }

  if (
    parsedResponse.protocol_version !== 1 &&
    parsedResponse.protocol_version !== 2 &&
    parsedResponse.protocol_version !== 3
  ) {
    throw new Error(
      "Invalid Patchmark response. Expected protocol_version 1, 2, or 3."
    );
  }
  const protocolVersion = parsedResponse.protocol_version;

  if (
    !Array.isArray(parsedResponse.replies) ||
    !Array.isArray(parsedResponse.patch_proposals) ||
    !Array.isArray(parsedResponse.open_questions)
  ) {
    throw new Error(
      "Invalid Patchmark response. Expected replies, patch_proposals, and open_questions arrays."
    );
  }

  if (protocolVersion === 3) {
    validateExternalResponseEnvelope(parsedResponse, rawInput);
  }
  const commonResponse = normalizeCommonResponseFields({
    changedStringPaths: normalization.changedStringPaths,
    parsedResponse,
    protocolVersion
  });
  let normalizedResponse: PatchmarkCommentReplyImport;

  if (protocolVersion === 3) {
    const newComments = (parsedResponse.new_comments as unknown[]).map(
      (comment, index) =>
        normalizeExternalComment({
          changedStringPaths: normalization.changedStringPaths,
          comment,
          documentId: parsedResponse.document_id as string,
          index
        })
    );
    const externalResponse: PatchmarkExternalParticipantResponse = {
      ...commonResponse,
      protocol: "patchmark.comment_reply_import",
      protocol_version: 3,
      review_batch_id: parsedResponse.review_batch_id as string,
      project_id: parsedResponse.project_id as string,
      document_id: parsedResponse.document_id as string,
      new_comments: newComments,
      patch_proposals: parsedResponse.patch_proposals.map(
        (patchProposal, index) =>
          normalizeExternalPatchProposal(
            patchProposal,
            index,
            normalization.changedStringPaths
          )
      )
    };
    validateExternalResponseLocalReferences(externalResponse);
    normalizedResponse = externalResponse;
  } else {
    if (parsedResponse.new_comments !== undefined) {
      throw new Error(
        "Invalid Patchmark response. new_comments requires protocol_version 3."
      );
    }
    const legacyResponse: PatchmarkLegacyCommentReplyImport = {
      ...commonResponse,
      protocol: "patchmark.comment_reply_import",
      protocol_version: protocolVersion,
      patch_proposals: parsedResponse.patch_proposals.map(
        (patchProposal, index) =>
          normalizeImportedPatchProposal(
            patchProposal,
            index,
            normalization.changedStringPaths,
            protocolVersion
          )
      )
    };
    normalizedResponse = legacyResponse;
  }

  validateConsistentRepeatedSourceDates(
    collectImportedSources(normalizedResponse)
  );
  validatePatchDependencyGraph(normalizedResponse);
  validatePatchProposalVisibleReferenceDates(
    normalizedResponse.patch_proposals,
    protocolVersion
  );

  return normalizedResponse;
}

export function validatePatchmarkExternalParticipantResponseScope({
  allowedExistingCommentIds,
  documentId,
  projectId,
  response,
  reviewBatchId
}: {
  allowedExistingCommentIds: ReadonlySet<string>;
  documentId: string;
  projectId: string;
  response: PatchmarkExternalParticipantResponse;
  reviewBatchId: string;
}): void {
  if (
    response.project_id !== projectId ||
    response.document_id !== documentId ||
    response.review_batch_id !== reviewBatchId
  ) {
    throw new Error(
      "Invalid Patchmark response. The external participant response is outside the allowed project, document, or Review Batch scope."
    );
  }

  const referencedExistingCommentIds = [
    ...response.replies.map((reply) => reply.comment_id),
    ...response.open_questions.map((question) => question.comment_id),
    ...response.patch_proposals.flatMap((patch) =>
      patch.comment_target.kind === "existing_comment"
        ? [patch.comment_target.comment_id]
        : []
    )
  ];
  const unknownCommentIds = Array.from(
    new Set(
      referencedExistingCommentIds.filter(
        (commentId) => !allowedExistingCommentIds.has(commentId)
      )
    )
  );
  if (unknownCommentIds.length > 0) {
    throw new Error(
      `Invalid Patchmark response. Existing comment target${
        unknownCommentIds.length === 1 ? "" : "s"
      } outside the allowed response scope: ${unknownCommentIds.join(", ")}.`
    );
  }
}

function normalizeCommonResponseFields({
  changedStringPaths,
  parsedResponse,
  protocolVersion
}: {
  changedStringPaths: Set<string>;
  parsedResponse: Record<string, unknown>;
  protocolVersion: 1 | 2 | 3;
}): Omit<
  PatchmarkLegacyCommentReplyImport,
  "patch_proposals" | "protocol" | "protocol_version"
> {
  return {
    review_batch_id:
      typeof parsedResponse.review_batch_id === "string"
        ? parsedResponse.review_batch_id
        : undefined,
    project_id:
      typeof parsedResponse.project_id === "string"
        ? parsedResponse.project_id
        : undefined,
    document_id:
      typeof parsedResponse.document_id === "string"
        ? parsedResponse.document_id
        : undefined,
    summary:
      typeof parsedResponse.summary === "string"
        ? normalizeOptionalProtocolTextField({
            changedStringPaths,
            fieldName: "summary",
            value: parsedResponse.summary
          })
        : undefined,
    sources: normalizeImportedSources(
      parsedResponse.sources,
      "sources",
      protocolVersion === 3
        ? PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
        : undefined
    ),
    replies: (parsedResponse.replies as unknown[]).map((reply, index) =>
      normalizeImportedReply(
        reply,
        index,
        changedStringPaths,
        protocolVersion === 3
      )
    ),
    open_questions: (parsedResponse.open_questions as unknown[]).map(
      (openQuestion, index) =>
        normalizeImportedOpenQuestion(
          openQuestion,
          index,
          changedStringPaths,
          protocolVersion === 3
        )
    )
  };
}

function validateExternalResponseEnvelope(
  response: Record<string, unknown>,
  rawInput: string
): asserts response is Record<string, unknown> & {
  document_id: string;
  new_comments: unknown[];
  patch_proposals: unknown[];
  project_id: string;
  review_batch_id: string;
} {
  assertExactObjectKeys(
    response,
    [
      "protocol",
      "protocol_version",
      "review_batch_id",
      "project_id",
      "document_id",
      "summary",
      "sources",
      "replies",
      "patch_proposals",
      "open_questions",
      "new_comments"
    ],
    "response"
  );
  if (
    typeof response.review_batch_id !== "string" ||
    typeof response.project_id !== "string" ||
    typeof response.document_id !== "string" ||
    !Array.isArray(response.new_comments) ||
    (response.summary !== undefined && typeof response.summary !== "string")
  ) {
    throw new Error(
      "Invalid Patchmark response. Protocol version 3 requires review_batch_id, project_id, document_id, and a new_comments array."
    );
  }
  assertBoundedIdentity(response.review_batch_id, "review_batch_id");
  assertBoundedIdentity(response.project_id, "project_id");
  assertBoundedIdentity(response.document_id, "document_id");
  if (!response.review_batch_id.startsWith("review_batch_")) {
    throw new Error(
      "Invalid Patchmark response. review_batch_id must preserve the exported Review Batch identity."
    );
  }
  if (
    new TextEncoder().encode(rawInput).byteLength >
    PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_response_bytes
  ) {
    throw new Error(
      `Invalid Patchmark response. Protocol version 3 is limited to ${PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_response_bytes} UTF-8 bytes.`
    );
  }
  for (const [fieldName, value] of [
    ["new_comments", response.new_comments],
    ["replies", response.replies],
    ["patch_proposals", response.patch_proposals],
    ["open_questions", response.open_questions]
  ] as const) {
    if (
      !Array.isArray(value) ||
      value.length > PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_array_items
    ) {
      throw new Error(
        `Invalid Patchmark response. ${fieldName} must contain at most ${PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_array_items} items.`
      );
    }
  }
  if (typeof response.summary === "string") {
    assertBoundedString(
      response.summary,
      "summary",
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length,
      { allowEmpty: true }
    );
  }
}

function normalizeExternalComment({
  changedStringPaths,
  comment,
  documentId,
  index
}: {
  changedStringPaths: Set<string>;
  comment: unknown;
  documentId: string;
  index: number;
}): PatchmarkExternalComment {
  const commentPath = `new_comments[${index}]`;
  assertExactObjectKeys(
    comment,
    ["local_ref", "document_id", "type", "anchor", "comment"],
    commentPath
  );
  if (
    typeof comment.local_ref !== "string" ||
    typeof comment.document_id !== "string" ||
    typeof comment.comment !== "string" ||
    !isCommentType(comment.type)
  ) {
    throw new Error(
      `Invalid Patchmark response. ${commentPath} needs local_ref, document_id, type, anchor, and comment.`
    );
  }
  assertResponseLocalRef(comment.local_ref, `${commentPath}.local_ref`);
  assertBoundedIdentity(comment.document_id, `${commentPath}.document_id`);
  if (comment.document_id !== documentId) {
    throw new Error(
      `Invalid Patchmark response. ${commentPath}.document_id is outside the response document scope.`
    );
  }

  return {
    local_ref: comment.local_ref,
    document_id: comment.document_id,
    type: comment.type,
    anchor: normalizeExternalCommentAnchor(
      comment.anchor,
      `${commentPath}.anchor`
    ),
    comment: validateBoundedProtocolTextField(
      normalizeRequiredProtocolField({
        changedStringPaths,
        fieldName: `${commentPath}.comment`,
        value: comment.comment
      }),
      `${commentPath}.comment`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length,
      { allowEmpty: false }
    )
  };
}

function normalizeExternalCommentAnchor(
  anchor: unknown,
  anchorPath: string
): PatchmarkExternalCommentAnchor {
  if (!isRecord(anchor) || typeof anchor.kind !== "string") {
    throw new Error(`Invalid Patchmark response. ${anchorPath} is malformed.`);
  }

  if (anchor.kind === "document") {
    assertExactObjectKeys(anchor, ["kind"], anchorPath);
    return { kind: "document" };
  }

  if (anchor.kind === "section") {
    assertExactObjectKeys(
      anchor,
      ["kind", "heading", "heading_level", "heading_line", "heading_path"],
      anchorPath
    );
    if (typeof anchor.heading !== "string") {
      throw new Error(`Invalid Patchmark response. ${anchorPath}.heading is required.`);
    }
    const heading = assertBoundedString(
      anchor.heading,
      `${anchorPath}.heading`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_heading_length,
      { allowEmpty: false }
    );
    const headingLevel = normalizeOptionalBoundedInteger(
      anchor.heading_level,
      `${anchorPath}.heading_level`,
      6
    );
    if (headingLevel !== undefined && headingLevel < 1) {
      throw new Error(
        `Invalid Patchmark response. ${anchorPath}.heading_level must be between 1 and 6.`
      );
    }
    return {
      kind: "section",
      heading,
      heading_level: headingLevel,
      heading_line: normalizeOptionalBoundedInteger(
        anchor.heading_line,
        `${anchorPath}.heading_line`
      ),
      heading_path: normalizeOptionalHeadingPath(
        anchor.heading_path,
        `${anchorPath}.heading_path`
      )
    };
  }

  if (anchor.kind !== "selected_text") {
    throw new Error(`Invalid Patchmark response. ${anchorPath}.kind is unsupported.`);
  }
  assertExactObjectKeys(
    anchor,
    [
      "kind",
      "selected_text",
      "selected_text_hash",
      "anchor_context",
      "markdown_start_offset",
      "markdown_end_offset",
      "context_before",
      "context_after",
      "containing_heading",
      "containing_heading_level",
      "containing_heading_line",
      "containing_heading_path",
      "anchor_source",
      "fallback_section_start_offset",
      "fallback_section_end_offset",
      "anchor_text",
      "anchor_text_source",
      "anchor_text_hash"
    ],
    anchorPath
  );
  if (typeof anchor.selected_text !== "string") {
    throw new Error(
      `Invalid Patchmark response. ${anchorPath}.selected_text is required.`
    );
  }
  const markdownStartOffset = normalizeOptionalBoundedInteger(
    anchor.markdown_start_offset,
    `${anchorPath}.markdown_start_offset`
  );
  const markdownEndOffset = normalizeOptionalBoundedInteger(
    anchor.markdown_end_offset,
    `${anchorPath}.markdown_end_offset`
  );
  assertOptionalRange(
    markdownStartOffset,
    markdownEndOffset,
    `${anchorPath}.markdown`
  );
  const fallbackStartOffset = normalizeOptionalBoundedInteger(
    anchor.fallback_section_start_offset,
    `${anchorPath}.fallback_section_start_offset`
  );
  const fallbackEndOffset = normalizeOptionalBoundedInteger(
    anchor.fallback_section_end_offset,
    `${anchorPath}.fallback_section_end_offset`
  );
  assertOptionalRange(
    fallbackStartOffset,
    fallbackEndOffset,
    `${anchorPath}.fallback_section`
  );
  const containingHeadingLevel = normalizeOptionalBoundedInteger(
    anchor.containing_heading_level,
    `${anchorPath}.containing_heading_level`,
    6
  );
  if (containingHeadingLevel !== undefined && containingHeadingLevel < 1) {
    throw new Error(
      `Invalid Patchmark response. ${anchorPath}.containing_heading_level must be between 1 and 6.`
    );
  }
  if (
    anchor.anchor_source !== undefined &&
    !["visual", "markdown", "patch"].includes(anchor.anchor_source as string)
  ) {
    throw new Error(
      `Invalid Patchmark response. ${anchorPath}.anchor_source is invalid.`
    );
  }
  if (
    anchor.anchor_text_source !== undefined &&
    !["selected", "expanded_sentence", "expanded_block"].includes(
      anchor.anchor_text_source as string
    )
  ) {
    throw new Error(
      `Invalid Patchmark response. ${anchorPath}.anchor_text_source is invalid.`
    );
  }

  return {
    kind: "selected_text",
    selected_text: assertBoundedString(
      anchor.selected_text,
      `${anchorPath}.selected_text`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_selected_text_length,
      { allowEmpty: false }
    ),
    selected_text_hash: normalizeOptionalBoundedString(
      anchor.selected_text_hash,
      `${anchorPath}.selected_text_hash`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_short_text_length
    ),
    anchor_context: normalizeOptionalAnchorContext(
      anchor.anchor_context,
      `${anchorPath}.anchor_context`
    ),
    markdown_start_offset: markdownStartOffset,
    markdown_end_offset: markdownEndOffset,
    context_before: normalizeOptionalBoundedString(
      anchor.context_before,
      `${anchorPath}.context_before`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_context_length,
      { allowEmpty: true }
    ),
    context_after: normalizeOptionalBoundedString(
      anchor.context_after,
      `${anchorPath}.context_after`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_context_length,
      { allowEmpty: true }
    ),
    containing_heading: normalizeOptionalBoundedString(
      anchor.containing_heading,
      `${anchorPath}.containing_heading`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_heading_length
    ),
    containing_heading_level: containingHeadingLevel,
    containing_heading_line: normalizeOptionalBoundedInteger(
      anchor.containing_heading_line,
      `${anchorPath}.containing_heading_line`
    ),
    containing_heading_path: normalizeOptionalHeadingPath(
      anchor.containing_heading_path,
      `${anchorPath}.containing_heading_path`
    ),
    anchor_source: anchor.anchor_source as
      | "visual"
      | "markdown"
      | "patch"
      | undefined,
    fallback_section_start_offset: fallbackStartOffset,
    fallback_section_end_offset: fallbackEndOffset,
    anchor_text: normalizeOptionalBoundedString(
      anchor.anchor_text,
      `${anchorPath}.anchor_text`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_selected_text_length
    ),
    anchor_text_source: anchor.anchor_text_source as
      | "selected"
      | "expanded_sentence"
      | "expanded_block"
      | undefined,
    anchor_text_hash: normalizeOptionalBoundedString(
      anchor.anchor_text_hash,
      `${anchorPath}.anchor_text_hash`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_short_text_length
    )
  };
}

function normalizeOptionalAnchorContext(
  context: unknown,
  contextPath: string
): PatchmarkSelectedTextAnchorContext | undefined {
  if (context === undefined) {
    return undefined;
  }
  assertExactObjectKeys(
    context,
    [
      "kind",
      "plain_text",
      "markdown_text",
      "selected_start_in_context",
      "selected_end_in_context",
      "context_hash",
      "markdown_start_offset",
      "markdown_end_offset",
      "table_index",
      "table_row_index",
      "table_cell_index",
      "table_row_start_offset",
      "table_row_end_offset",
      "table_cell_start_offset",
      "table_cell_end_offset"
    ],
    contextPath
  );
  if (
    !isAnchorContextKind(context.kind) ||
    typeof context.plain_text !== "string"
  ) {
    throw new Error(`Invalid Patchmark response. ${contextPath} is malformed.`);
  }
  const selectedStart = normalizeOptionalBoundedInteger(
    context.selected_start_in_context,
    `${contextPath}.selected_start_in_context`
  );
  const selectedEnd = normalizeOptionalBoundedInteger(
    context.selected_end_in_context,
    `${contextPath}.selected_end_in_context`
  );
  assertOptionalRange(selectedStart, selectedEnd, `${contextPath}.selected`);
  if (selectedEnd !== undefined && selectedEnd > context.plain_text.length) {
    throw new Error(
      `Invalid Patchmark response. ${contextPath} selected range exceeds plain_text.`
    );
  }
  const markdownStart = normalizeOptionalBoundedInteger(
    context.markdown_start_offset,
    `${contextPath}.markdown_start_offset`
  );
  const markdownEnd = normalizeOptionalBoundedInteger(
    context.markdown_end_offset,
    `${contextPath}.markdown_end_offset`
  );
  assertOptionalRange(markdownStart, markdownEnd, `${contextPath}.markdown`);
  const tableRowStart = normalizeOptionalBoundedInteger(
    context.table_row_start_offset,
    `${contextPath}.table_row_start_offset`
  );
  const tableRowEnd = normalizeOptionalBoundedInteger(
    context.table_row_end_offset,
    `${contextPath}.table_row_end_offset`
  );
  assertOptionalRange(tableRowStart, tableRowEnd, `${contextPath}.table_row`);
  const tableCellStart = normalizeOptionalBoundedInteger(
    context.table_cell_start_offset,
    `${contextPath}.table_cell_start_offset`
  );
  const tableCellEnd = normalizeOptionalBoundedInteger(
    context.table_cell_end_offset,
    `${contextPath}.table_cell_end_offset`
  );
  assertOptionalRange(tableCellStart, tableCellEnd, `${contextPath}.table_cell`);

  return {
    kind: context.kind,
    plain_text: assertBoundedString(
      context.plain_text,
      `${contextPath}.plain_text`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_context_length,
      { allowEmpty: false }
    ),
    markdown_text: normalizeOptionalBoundedString(
      context.markdown_text,
      `${contextPath}.markdown_text`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_context_length,
      { allowEmpty: true }
    ),
    selected_start_in_context: selectedStart,
    selected_end_in_context: selectedEnd,
    context_hash: normalizeOptionalBoundedString(
      context.context_hash,
      `${contextPath}.context_hash`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_short_text_length
    ),
    markdown_start_offset: markdownStart,
    markdown_end_offset: markdownEnd,
    table_index: normalizeOptionalBoundedInteger(
      context.table_index,
      `${contextPath}.table_index`
    ),
    table_row_index: normalizeOptionalBoundedInteger(
      context.table_row_index,
      `${contextPath}.table_row_index`
    ),
    table_cell_index: normalizeOptionalBoundedInteger(
      context.table_cell_index,
      `${contextPath}.table_cell_index`
    ),
    table_row_start_offset: tableRowStart,
    table_row_end_offset: tableRowEnd,
    table_cell_start_offset: tableCellStart,
    table_cell_end_offset: tableCellEnd
  };
}

function normalizeResponseCommentTarget(
  target: unknown,
  targetPath: string
): PatchmarkResponseCommentTarget {
  if (!isRecord(target) || typeof target.kind !== "string") {
    throw new Error(`Invalid Patchmark response. ${targetPath} is malformed.`);
  }
  if (target.kind === "existing_comment") {
    assertExactObjectKeys(target, ["kind", "comment_id"], targetPath);
    if (typeof target.comment_id !== "string") {
      throw new Error(
        `Invalid Patchmark response. ${targetPath}.comment_id is required.`
      );
    }
    assertBoundedIdentity(target.comment_id, `${targetPath}.comment_id`);
    return { kind: "existing_comment", comment_id: target.comment_id };
  }
  if (target.kind === "response_comment") {
    assertExactObjectKeys(target, ["kind", "local_ref"], targetPath);
    if (typeof target.local_ref !== "string") {
      throw new Error(
        `Invalid Patchmark response. ${targetPath}.local_ref is required.`
      );
    }
    assertResponseLocalRef(target.local_ref, `${targetPath}.local_ref`);
    return { kind: "response_comment", local_ref: target.local_ref };
  }
  throw new Error(`Invalid Patchmark response. ${targetPath}.kind is unsupported.`);
}

function validateExternalResponseLocalReferences(
  response: PatchmarkExternalParticipantResponse
): void {
  const localRefs = new Set<string>();
  for (const comment of response.new_comments) {
    if (localRefs.has(comment.local_ref)) {
      throw new Error(
        `Invalid Patchmark response. Duplicate response-local comment reference: ${comment.local_ref}.`
      );
    }
    localRefs.add(comment.local_ref);
  }
  for (const patch of response.patch_proposals) {
    if (
      patch.comment_target.kind === "response_comment" &&
      !localRefs.has(patch.comment_target.local_ref)
    ) {
      throw new Error(
        `Invalid Patchmark response. Patch ${patch.patch_key} references unknown response-local comment ${patch.comment_target.local_ref}.`
      );
    }
  }
}

function assertExactObjectKeys(
  value: unknown,
  allowedKeys: readonly string[],
  path: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid Patchmark response. ${path} must be an object.`);
  }
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid Patchmark response. ${path} contains unsupported field${
        unknownKeys.length === 1 ? "" : "s"
      }: ${unknownKeys.join(", ")}.`
    );
  }
}

function assertResponseLocalRef(value: string, path: string): void {
  if (
    value.length === 0 ||
    value.length > PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_local_ref_length ||
    !RESPONSE_LOCAL_COMMENT_REF_PATTERN.test(value) ||
    value.startsWith("pm-") ||
    value.startsWith("patchmark-")
  ) {
    throw new Error(
      `Invalid Patchmark response. ${path} must be a lowercase response-local reference of at most ${PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_local_ref_length} characters and must not use a Patchmark ID prefix.`
    );
  }
}

function assertBoundedIdentity(value: string, path: string): string {
  return assertBoundedString(
    value,
    path,
    PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_identity_length,
    { allowEmpty: false, rejectControlCharacters: true, requireTrimmed: true }
  );
}

function assertBoundedString(
  value: string,
  path: string,
  maximumLength: number,
  options: {
    allowEmpty?: boolean;
    rejectControlCharacters?: boolean;
    requireTrimmed?: boolean;
  } = {}
): string {
  if (
    value.length > maximumLength ||
    (!options.allowEmpty && value.trim().length === 0) ||
    (options.requireTrimmed && value !== value.trim()) ||
    (options.rejectControlCharacters && CONTROL_CHARACTER_PATTERN.test(value))
  ) {
    throw new Error(
      `Invalid Patchmark response. ${path} exceeds its bounds or has invalid text.`
    );
  }
  return value;
}

function validateBoundedProtocolTextField(
  value: string,
  fieldName: string,
  maximumLength: number,
  options: { allowEmpty?: boolean } = {}
): string {
  assertBoundedString(value, fieldName, maximumLength, options);
  return validateProtocolTextField(value, fieldName);
}

function normalizeOptionalBoundedString(
  value: unknown,
  path: string,
  maximumLength: number,
  options: { allowEmpty?: boolean } = {}
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid Patchmark response. ${path} must be a string.`);
  }
  return assertBoundedString(value, path, maximumLength, options);
}

function normalizeOptionalBoundedInteger(
  value: unknown,
  path: string,
  maximum: number = PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_offset
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(
      `Invalid Patchmark response. ${path} must be a bounded non-negative integer.`
    );
  }
  return value as number;
}

function assertOptionalRange(
  start: number | undefined,
  end: number | undefined,
  path: string
): void {
  if ((start === undefined) !== (end === undefined) || (start !== undefined && end! < start)) {
    throw new Error(
      `Invalid Patchmark response. ${path} start/end offsets must be a complete ordered pair.`
    );
  }
}

function normalizeOptionalHeadingPath(
  value: unknown,
  path: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_heading_path_items
  ) {
    throw new Error(`Invalid Patchmark response. ${path} is malformed.`);
  }
  return value.map((heading, index) => {
    if (typeof heading !== "string") {
      throw new Error(
        `Invalid Patchmark response. ${path}[${index}] must be a string.`
      );
    }
    return assertBoundedString(
      heading,
      `${path}[${index}]`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_heading_length,
      { allowEmpty: false }
    );
  });
}

function isCommentType(value: unknown): value is PatchmarkExternalComment["type"] {
  return (
    typeof value === "string" &&
    ["note", "question", "risk", "research_needed", "decision_needed"].includes(
      value
    )
  );
}

function isAnchorContextKind(
  value: unknown
): value is NonNullable<
  Extract<PatchmarkExternalCommentAnchor, { kind: "selected_text" }>["anchor_context"]
>["kind"] {
  return (
    typeof value === "string" &&
    [
      "sentence",
      "paragraph",
      "heading",
      "list_item",
      "table_cell",
      "blockquote",
      "block",
      "section"
    ].includes(value)
  );
}

export function normalizeSourceChatUrl(sourceChatUrl: string): string | undefined {
  const trimmedUrl = sourceChatUrl.trim();

  if (!trimmedUrl) {
    return undefined;
  }

  try {
    const url = new URL(trimmedUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Invalid protocol.");
    }

    return url.toString();
  } catch {
    throw new Error("Source ChatGPT URL must be a valid http(s) URL.");
  }
}

function normalizeInternalCitationArtifactsInJsonValue(
  value: unknown
): CitationNormalizationResult {
  const changedStringPaths = new Set<string>();

  return {
    changedStringPaths,
    value: normalizeJsonValue(value, [], changedStringPaths)
  };
}

function normalizeJsonValue(
  value: unknown,
  path: JsonPathPart[],
  changedStringPaths: Set<string>
): unknown {
  if (typeof value === "string") {
    if (path.at(-1) === "url") {
      return value;
    }

    const normalizedValue = removeInternalCitationArtifacts(value);

    if (normalizedValue !== value) {
      changedStringPaths.add(formatJsonPath(path));
    }

    return normalizedValue;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeJsonValue(item, [...path, index], changedStringPaths)
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      normalizeJsonValue(entryValue, [...path, key], changedStringPaths)
    ])
  );
}

function removeInternalCitationArtifacts(value: string): string {
  const protectedFragments: string[] = [];
  const protectedValue = value
    .replace(DOCUMENT_MARKDOWN_LINK_PATTERN, (fragment) =>
      protectCitationCleanupFragment(fragment, protectedFragments)
    )
    .replace(RAW_URL_PATTERN, (fragment) =>
      protectCitationCleanupFragment(fragment, protectedFragments)
    );
  const normalizedValue = [
    CONTENT_REFERENCE_PATTERN,
    PRIVATE_USE_CITATION_PATTERN,
    BRACKETED_INTERNAL_CITATION_PATTERN,
    OAICITE_REFERENCE_PATTERN,
    OAICITE_TOKEN_PATTERN,
    INTERNAL_TURN_ID_PATTERN
  ].reduce(
    (currentValue, pattern) => currentValue.replace(pattern, ""),
    protectedValue
  );

  const restoredValue = restoreCitationCleanupFragments(
    normalizedValue,
    protectedFragments
  );

  if (restoredValue === value) {
    return value;
  }

  return restoredValue
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function protectCitationCleanupFragment(
  fragment: string,
  protectedFragments: string[]
): string {
  const index = protectedFragments.push(fragment) - 1;

  return `\u0000PATCHMARK_PROTECTED_${index}\u0000`;
}

function restoreCitationCleanupFragments(
  value: string,
  protectedFragments: string[]
): string {
  return value.replace(
    /\u0000PATCHMARK_PROTECTED_(\d+)\u0000/g,
    (_match, indexValue: string) => protectedFragments[Number(indexValue)] ?? ""
  );
}

function stripMarkdownJsonFence(rawInput: string): string {
  const trimmedInput = rawInput.trim();
  const fencedMatch = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmedInput);

  return fencedMatch ? fencedMatch[1].trim() : trimmedInput;
}

function normalizeImportedReply(
  reply: unknown,
  index: number,
  changedStringPaths: Set<string>,
  bounded = false
): PatchmarkCommentReplyImport["replies"][number] {
  if (
    !isRecord(reply) ||
    typeof reply.comment_id !== "string" ||
    typeof reply.reply !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each reply needs comment_id and reply."
    );
  }

  const replyPath = `replies[${index}]`;
  const replySourcesInput = reply.reply_sources ?? reply.sources;
  const replySourcesPath =
    reply.reply_sources === undefined
      ? `${replyPath}.sources`
      : `${replyPath}.reply_sources`;
  if (bounded) {
    assertExactObjectKeys(
      reply,
      [
        "comment_id",
        "reply",
        "reply_sources",
        "suggested_user_action",
        "sources"
      ],
      replyPath
    );
    assertBoundedIdentity(reply.comment_id, `${replyPath}.comment_id`);
    if (
      reply.suggested_user_action !== undefined &&
      !isSuggestedUserAction(reply.suggested_user_action)
    ) {
      throw new Error(
        `Invalid Patchmark response. ${replyPath}.suggested_user_action is invalid.`
      );
    }
  }

  return {
    comment_id: normalizeRequiredProtocolField({
      changedStringPaths,
      fieldName: `${replyPath}.comment_id`,
      value: reply.comment_id
    }),
    reply: bounded
      ? validateBoundedProtocolTextField(
          normalizeRequiredProtocolField({
            changedStringPaths,
            fieldName: `${replyPath}.reply`,
            value: reply.reply
          }),
          `${replyPath}.reply`,
          PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length
        )
      : validateProtocolTextField(
      normalizeRequiredProtocolField({
        changedStringPaths,
        fieldName: `${replyPath}.reply`,
        value: reply.reply
      }),
          `${replyPath}.reply`
        ),
    reply_sources: normalizeImportedSources(
      replySourcesInput,
      replySourcesPath,
      bounded
        ? PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
        : undefined
    ),
    suggested_user_action: isSuggestedUserAction(reply.suggested_user_action)
      ? reply.suggested_user_action
      : undefined,
    sources: normalizeImportedSources(
      reply.sources,
      `${replyPath}.sources`,
      bounded
        ? PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
        : undefined
    )
  };
}

function normalizeImportedPatchProposal(
  patchProposal: unknown,
  index: number,
  changedStringPaths: Set<string>,
  protocolVersion: 1 | 2
): PatchmarkLegacyPatchProposal {
  if (
    !isRecord(patchProposal) ||
    typeof patchProposal.comment_id !== "string" ||
    patchProposal.comment_target !== undefined ||
    typeof patchProposal.original_text !== "string" ||
    typeof patchProposal.suggested_text !== "string" ||
    typeof patchProposal.reason !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each patch proposal needs comment_id, original_text, suggested_text, and reason."
    );
  }

  const patchProposalPath = `patch_proposals[${index}]`;
  const reasonSourcesInput =
    patchProposal.reason_sources ?? patchProposal.sources;
  const reasonSourcesPath =
    patchProposal.reason_sources === undefined
      ? `${patchProposalPath}.sources`
      : `${patchProposalPath}.reason_sources`;
  const originalText = normalizeRequiredProtocolField({
    changedStringPaths,
    fieldName: `${patchProposalPath}.original_text`,
    value: patchProposal.original_text
  });
  const suggestedText = normalizeRequiredProtocolField({
    changedStringPaths,
    fieldName: `${patchProposalPath}.suggested_text`,
    value: patchProposal.suggested_text
  });

  if (
    containsReservedPatchmarkTableMarker(originalText) ||
    containsReservedPatchmarkTableMarker(suggestedText)
  ) {
    throw new Error(RESERVED_PATCHMARK_TABLE_MARKER_ERROR);
  }
  const dependencyFields = normalizePatchDependencyFields({
    patchProposal,
    patchProposalPath,
    protocolVersion
  });

  return {
    ...dependencyFields,
    comment_id: normalizeRequiredProtocolField({
      changedStringPaths,
      fieldName: `${patchProposalPath}.comment_id`,
      value: patchProposal.comment_id
    }),
    display_title: normalizeImportedPatchDisplayTitle(
      patchProposal,
      patchProposalPath
    ),
    target_heading:
      typeof patchProposal.target_heading === "string"
        ? patchProposal.target_heading
        : undefined,
    original_text: originalText,
    suggested_text: suggestedText,
    suggested_text_sources: normalizeImportedSources(
      patchProposal.suggested_text_sources,
      `${patchProposalPath}.suggested_text_sources`
    ),
    reason: validateProtocolTextField(
      normalizeRequiredProtocolField({
        changedStringPaths,
        fieldName: `${patchProposalPath}.reason`,
        value: patchProposal.reason
      }),
      `${patchProposalPath}.reason`
    ),
    reason_sources: normalizeImportedSources(
      reasonSourcesInput,
      reasonSourcesPath
    ),
    risk:
      typeof patchProposal.risk === "string"
        ? validateProtocolTextField(
            patchProposal.risk,
            `${patchProposalPath}.risk`
          )
        : undefined,
    risk_sources: normalizeImportedSources(
      patchProposal.risk_sources,
      `${patchProposalPath}.risk_sources`
    ),
    sources: normalizeImportedSources(
      patchProposal.sources,
      `${patchProposalPath}.sources`
    )
  };
}

function normalizeExternalPatchProposal(
  patchProposal: unknown,
  index: number,
  changedStringPaths: Set<string>
): PatchmarkExternalPatchProposal {
  const patchProposalPath = `patch_proposals[${index}]`;
  assertExactObjectKeys(
    patchProposal,
    [
      "patch_key",
      "depends_on",
      "comment_target",
      "display_title",
      "title",
      "target_heading",
      "original_text",
      "suggested_text",
      "suggested_text_sources",
      "reason",
      "reason_sources",
      "risk",
      "risk_sources",
      "sources"
    ],
    patchProposalPath
  );
  if (
    typeof patchProposal.original_text !== "string" ||
    typeof patchProposal.suggested_text !== "string" ||
    typeof patchProposal.reason !== "string" ||
    (patchProposal.display_title !== undefined &&
      typeof patchProposal.display_title !== "string") ||
    (patchProposal.title !== undefined &&
      typeof patchProposal.title !== "string") ||
    (patchProposal.target_heading !== undefined &&
      typeof patchProposal.target_heading !== "string") ||
    (patchProposal.risk !== undefined && typeof patchProposal.risk !== "string")
  ) {
    throw new Error(
      "Invalid Patchmark response. Each protocol-v3 patch proposal needs comment_target, original_text, suggested_text, and reason."
    );
  }

  const reasonSourcesInput =
    patchProposal.reason_sources ?? patchProposal.sources;
  const reasonSourcesPath =
    patchProposal.reason_sources === undefined
      ? `${patchProposalPath}.sources`
      : `${patchProposalPath}.reason_sources`;
  const originalText = normalizeRequiredProtocolField({
    changedStringPaths,
    fieldName: `${patchProposalPath}.original_text`,
    value: patchProposal.original_text
  });
  const suggestedText = normalizeRequiredProtocolField({
    changedStringPaths,
    fieldName: `${patchProposalPath}.suggested_text`,
    value: patchProposal.suggested_text
  });

  if (
    containsReservedPatchmarkTableMarker(originalText) ||
    containsReservedPatchmarkTableMarker(suggestedText)
  ) {
    throw new Error(RESERVED_PATCHMARK_TABLE_MARKER_ERROR);
  }
  assertBoundedString(
    originalText,
    `${patchProposalPath}.original_text`,
    PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length,
    { allowEmpty: false }
  );
  assertBoundedString(
    suggestedText,
    `${patchProposalPath}.suggested_text`,
    PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length,
    { allowEmpty: true }
  );
  const dependencyFields = normalizePatchDependencyFields({
    patchProposal,
    patchProposalPath,
    protocolVersion: 3
  });

  const displayTitle = normalizeImportedPatchDisplayTitle(
    patchProposal,
    patchProposalPath
  );
  if (displayTitle !== undefined) {
    assertBoundedString(
      displayTitle,
      `${patchProposalPath}.display_title`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_short_text_length,
      { allowEmpty: false }
    );
  }

  return {
    patch_key: dependencyFields.patch_key as string,
    depends_on: dependencyFields.depends_on as string[],
    comment_target: normalizeResponseCommentTarget(
      patchProposal.comment_target,
      `${patchProposalPath}.comment_target`
    ),
    display_title: displayTitle,
    target_heading:
      typeof patchProposal.target_heading === "string"
        ? assertBoundedString(
            patchProposal.target_heading,
            `${patchProposalPath}.target_heading`,
            PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_heading_length,
            { allowEmpty: false }
          )
        : undefined,
    original_text: originalText,
    suggested_text: suggestedText,
    suggested_text_sources: normalizeImportedSources(
      patchProposal.suggested_text_sources,
      `${patchProposalPath}.suggested_text_sources`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
    ),
    reason: validateBoundedProtocolTextField(
      normalizeRequiredProtocolField({
        changedStringPaths,
        fieldName: `${patchProposalPath}.reason`,
        value: patchProposal.reason
      }),
      `${patchProposalPath}.reason`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length
    ),
    reason_sources: normalizeImportedSources(
      reasonSourcesInput,
      reasonSourcesPath,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
    ),
    risk:
      typeof patchProposal.risk === "string"
        ? validateBoundedProtocolTextField(
            patchProposal.risk,
            `${patchProposalPath}.risk`,
            PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length
          )
        : undefined,
    risk_sources: normalizeImportedSources(
      patchProposal.risk_sources,
      `${patchProposalPath}.risk_sources`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
    ),
    sources: normalizeImportedSources(
      patchProposal.sources,
      `${patchProposalPath}.sources`,
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
    )
  };
}

function normalizePatchDependencyFields({
  patchProposal,
  patchProposalPath,
  protocolVersion
}: {
  patchProposal: Record<string, unknown>;
  patchProposalPath: string;
  protocolVersion: 1 | 2 | 3;
}): Pick<
  PatchmarkCommentReplyImport["patch_proposals"][number],
  "depends_on" | "patch_key"
> {
  if (protocolVersion === 1) {
    if (
      patchProposal.patch_key !== undefined ||
      patchProposal.depends_on !== undefined
    ) {
      throw new PatchDependencyValidationError({
        code: "unsupported_dependency_protocol",
        message:
          "Protocol version 1 patch proposals cannot include patch_key or depends_on."
      });
    }

    return {};
  }

  if (
    typeof patchProposal.patch_key !== "string" ||
    patchProposal.patch_key.trim().length === 0 ||
    patchProposal.patch_key !== patchProposal.patch_key.trim() ||
    /[\u0000-\u001f\u007f]/.test(patchProposal.patch_key) ||
    !Array.isArray(patchProposal.depends_on) ||
    patchProposal.depends_on.some(
      (dependency) =>
        typeof dependency !== "string" ||
        dependency.trim().length === 0 ||
        dependency !== dependency.trim() ||
        /[\u0000-\u001f\u007f]/.test(dependency)
    )
  ) {
    throw new PatchDependencyValidationError({
      code: "unsupported_dependency_protocol",
      message: `Invalid dependency fields at ${patchProposalPath}. Protocol version ${protocolVersion} requires a non-empty patch_key and a string depends_on array.`
    });
  }

  if (protocolVersion === 3) {
    assertResponseLocalRef(
      patchProposal.patch_key,
      `${patchProposalPath}.patch_key`
    );
    if (
      patchProposal.depends_on.length >
      PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_array_items
    ) {
      throw new PatchDependencyValidationError({
        code: "unsupported_dependency_protocol",
        message: `Invalid dependency fields at ${patchProposalPath}. Too many dependency references.`
      });
    }
    patchProposal.depends_on.forEach((dependency, dependencyIndex) =>
      assertResponseLocalRef(
        dependency as string,
        `${patchProposalPath}.depends_on[${dependencyIndex}]`
      )
    );
  }

  return {
    depends_on: patchProposal.depends_on as string[],
    patch_key: patchProposal.patch_key
  };
}

function normalizeImportedPatchDisplayTitle(
  patchProposal: Record<string, unknown>,
  patchProposalPath: string
): string | undefined {
  const titleInput =
    typeof patchProposal.display_title === "string"
      ? patchProposal.display_title
      : typeof patchProposal.title === "string"
        ? patchProposal.title
        : undefined;

  if (titleInput === undefined) {
    return undefined;
  }

  const title = validateProtocolTextField(
    titleInput,
    `${patchProposalPath}.display_title`
  );

  return normalizePatchDisplayTitleCandidate(title) ?? undefined;
}

function normalizeRequiredProtocolField({
  changedStringPaths,
  fieldName,
  value
}: {
  changedStringPaths: Set<string>;
  fieldName: string;
  value: string;
}): string {
  if (changedStringPaths.has(fieldName) && value.trim() === "") {
    throw new Error(
      `Invalid Patchmark response. Required field became empty after cleanup: ${fieldName}.`
    );
  }

  return value;
}

function normalizeOptionalProtocolTextField({
  changedStringPaths,
  fieldName,
  value
}: {
  changedStringPaths: Set<string>;
  fieldName: string;
  value: string;
}): string | undefined {
  if (changedStringPaths.has(fieldName) && value.trim() === "") {
    return undefined;
  }

  return validateProtocolTextField(value, fieldName);
}

function validateProtocolTextField(value: string, fieldName: string): string {
  if (
    PROTOCOL_URL_PATTERN.test(value) ||
    PROTOCOL_MARKDOWN_LINK_PATTERN.test(value) ||
    PROTOCOL_BROKEN_MARKDOWN_LINK_PATTERN.test(value) ||
    PROTOCOL_REFERENCE_LINK_PATTERN.test(value) ||
    PROTOCOL_FOOTNOTE_PATTERN.test(value)
  ) {
    throw new Error(`${STRICT_CHATGPT_IMPORT_ERROR} Invalid field: ${fieldName}.`);
  }

  return value;
}

function normalizeSourceTextField(
  value: unknown,
  fieldPath: string
): string | undefined {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid source field at ${fieldPath}. Source title, note, and supports must be plain text strings.`
    );
  }

  const trimmedValue = value.trim();

  return trimmedValue
    ? validateProtocolTextField(trimmedValue, fieldPath)
    : undefined;
}

function normalizeImportedSources(
  sources: unknown,
  arrayPath: string,
  maximumItems?: number
): PatchmarkSourceReference[] | undefined {
  if (sources === undefined) {
    return undefined;
  }

  if (!Array.isArray(sources)) {
    throw new Error(
      `Invalid source array at ${arrayPath}. Sources must be arrays of source objects.`
    );
  }
  if (maximumItems !== undefined && sources.length > maximumItems) {
    throw new Error(
      `Invalid source array at ${arrayPath}. At most ${maximumItems} sources are allowed.`
    );
  }

  return sources.map((source, index) =>
    normalizeImportedSourceReference(source, `${arrayPath}[${index}]`)
  );
}

function normalizeImportedSourceReference(
  source: unknown,
  sourcePath: string
): PatchmarkSourceReference {
  if (!isRecord(source)) {
    throw new Error(
      `Invalid source object at ${sourcePath}. Every source must be an object with a raw url string.`
    );
  }

  if (typeof source.url !== "string") {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  const rawUrl = source.url;

  if (!rawUrl.trim() || rawUrl.trim() !== rawUrl) {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  if (
    (!rawUrl.startsWith("https://") && !rawUrl.startsWith("http://")) ||
    SOURCE_URL_MARKDOWN_PATTERN.test(rawUrl)
  ) {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  let normalizedUrl: string;

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Invalid protocol.");
    }

    normalizedUrl = url.toString();
  } catch {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  const title =
    source.title === undefined
      ? undefined
      : normalizeSourceTextField(source.title, `${sourcePath}.title`);
  const note =
    source.note === undefined
      ? undefined
      : normalizeSourceTextField(source.note, `${sourcePath}.note`);
  const supports =
    source.supports === undefined
      ? undefined
      : normalizeSourceTextField(source.supports, `${sourcePath}.supports`);
  const publishedAt = normalizeSourceDateField({
    fieldPath: `${sourcePath}.published_at`,
    required: true,
    value: source.published_at
  });
  const updatedAt = normalizeSourceDateField({
    fieldPath: `${sourcePath}.updated_at`,
    required: false,
    value: source.updated_at
  });
  const observedAt = normalizeSourceDateField({
    fieldPath: `${sourcePath}.observed_at`,
    required: true,
    value: source.observed_at
  });

  if (!supports) {
    throw new Error(`Invalid source field at ${sourcePath}.supports.`);
  }

  if (typeof observedAt !== "string") {
    throw new Error("The source metadata is missing observed_at.");
  }

  validateSourceDateOrder({
    observedAt,
    publishedAt: publishedAt ?? null,
    sourcePath,
    sourceText: [title ?? "", note ?? "", supports, normalizedUrl].join(" "),
    updatedAt
  });

  return {
    title,
    url: normalizedUrl,
    published_at: publishedAt ?? null,
    updated_at: updatedAt ?? null,
    observed_at: observedAt,
    note,
    supports
  };
}

function collectImportedSources(
  response: PatchmarkCommentReplyImport
): PatchmarkSourceReference[] {
  return [
    ...(response.sources ?? []),
    ...response.replies.flatMap((reply) => [
      ...(reply.reply_sources ?? []),
      ...(reply.sources ?? [])
    ]),
    ...response.patch_proposals.flatMap((patchProposal) => [
      ...(patchProposal.suggested_text_sources ?? []),
      ...(patchProposal.reason_sources ?? []),
      ...(patchProposal.risk_sources ?? []),
      ...(patchProposal.sources ?? [])
    ]),
    ...response.open_questions.flatMap(
      (openQuestion) => openQuestion.question_sources ?? []
    )
  ];
}

function validatePatchProposalVisibleReferenceDates(
  patchProposals: PatchmarkCommentReplyImport["patch_proposals"],
  protocolVersion: 1 | 2 | 3
) {
  for (const patchProposal of patchProposals) {
    if (
      protocolVersion >= 2 &&
      (patchProposal.depends_on?.length ?? 0) > 0
    ) {
      continue;
    }

    try {
      validateSuggestedTextReferenceDates({
        originalText: patchProposal.original_text,
        sources: patchProposal.suggested_text_sources ?? [],
        suggestedText: patchProposal.suggested_text
      });
    } catch (error) {
      if (
        protocolVersion < 2 ||
        !(error instanceof SourceReferenceValidationError)
      ) {
        throw error;
      }

      const patchKey = patchProposal.patch_key;
      throw new PatchDependencyValidationError({
        code: "dependency_source_date_coverage_failed",
        disclosurePrerequisiteStatus: "absent",
        message: `Patch ${patchKey} failed dependency-aware source-date validation. Source ${error.sourceUrl}${
          error.observedAt
            ? ` requires observation date ${error.observedAt}`
            : ""
        }. No disclosure prerequisite is declared.`,
        observedAt: error.observedAt,
        patchKey,
        sourceUrl: error.sourceUrl
      });
    }
  }
}

function normalizeImportedOpenQuestion(
  openQuestion: unknown,
  index: number,
  changedStringPaths: Set<string>,
  bounded = false
): PatchmarkCommentReplyImport["open_questions"][number] {
  if (
    !isRecord(openQuestion) ||
    typeof openQuestion.comment_id !== "string" ||
    typeof openQuestion.question !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each open question needs comment_id and question."
    );
  }

  const openQuestionPath = `open_questions[${index}]`;
  if (bounded) {
    assertExactObjectKeys(
      openQuestion,
      ["comment_id", "question", "question_sources"],
      openQuestionPath
    );
    assertBoundedIdentity(
      openQuestion.comment_id,
      `${openQuestionPath}.comment_id`
    );
  }

  return {
    comment_id: normalizeRequiredProtocolField({
      changedStringPaths,
      fieldName: `${openQuestionPath}.comment_id`,
      value: openQuestion.comment_id
    }),
    question: bounded
      ? validateBoundedProtocolTextField(
          normalizeRequiredProtocolField({
            changedStringPaths,
            fieldName: `${openQuestionPath}.question`,
            value: openQuestion.question
          }),
          `${openQuestionPath}.question`,
          PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length
        )
      : validateProtocolTextField(
          normalizeRequiredProtocolField({
            changedStringPaths,
            fieldName: `${openQuestionPath}.question`,
            value: openQuestion.question
          }),
          `${openQuestionPath}.question`
        ),
    question_sources: normalizeImportedSources(
      openQuestion.question_sources,
      `${openQuestionPath}.question_sources`,
      bounded
        ? PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_sources_per_field
        : undefined
    )
  };
}

function formatJsonPath(path: JsonPathPart[]): string {
  return path.reduce<string>((currentPath, pathPart) => {
    if (typeof pathPart === "number") {
      return `${currentPath}[${pathPart}]`;
    }

    return currentPath ? `${currentPath}.${pathPart}` : pathPart;
  }, "");
}

function isSuggestedUserAction(
  value: unknown
): value is PatchmarkSuggestedUserAction {
  return (
    typeof value === "string" &&
    [
      "review",
      "clarify",
      "apply_patch",
      "keep_open",
      "resolve_manually"
    ].includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

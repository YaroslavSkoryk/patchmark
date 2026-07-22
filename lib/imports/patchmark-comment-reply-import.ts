import type {
  PatchmarkCommentReplyImport,
  PatchmarkSourceReference,
  PatchmarkSuggestedUserAction
} from "../project/project-types.ts";
import { containsReservedPatchmarkTableMarker } from "../patches/atomic-table-patches.ts";
import { normalizePatchDisplayTitleCandidate } from "../patches/patch-display-title.ts";
import {
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

  if (parsedResponse.protocol_version !== 1) {
    throw new Error(
      "Invalid Patchmark response. Expected protocol_version 1."
    );
  }

  if (
    !Array.isArray(parsedResponse.replies) ||
    !Array.isArray(parsedResponse.patch_proposals) ||
    !Array.isArray(parsedResponse.open_questions)
  ) {
    throw new Error(
      "Invalid Patchmark response. Expected replies, patch_proposals, and open_questions arrays."
    );
  }

  const normalizedResponse: PatchmarkCommentReplyImport = {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
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
            changedStringPaths: normalization.changedStringPaths,
            fieldName: "summary",
            value: parsedResponse.summary
          })
        : undefined,
    sources: normalizeImportedSources(parsedResponse.sources, "sources"),
    replies: parsedResponse.replies.map((reply, index) =>
      normalizeImportedReply(reply, index, normalization.changedStringPaths)
    ),
    patch_proposals:
      parsedResponse.patch_proposals.map((patchProposal, index) =>
        normalizeImportedPatchProposal(
          patchProposal,
          index,
          normalization.changedStringPaths
        )
      ),
    open_questions:
      parsedResponse.open_questions.map((openQuestion, index) =>
        normalizeImportedOpenQuestion(
          openQuestion,
          index,
          normalization.changedStringPaths
        )
      )
  };

  validateConsistentRepeatedSourceDates(
    collectImportedSources(normalizedResponse)
  );
  validatePatchProposalVisibleReferenceDates(normalizedResponse.patch_proposals);

  return normalizedResponse;
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
  changedStringPaths: Set<string>
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

  return {
    comment_id: normalizeRequiredProtocolField({
      changedStringPaths,
      fieldName: `${replyPath}.comment_id`,
      value: reply.comment_id
    }),
    reply: validateProtocolTextField(
      normalizeRequiredProtocolField({
        changedStringPaths,
        fieldName: `${replyPath}.reply`,
        value: reply.reply
      }),
      `${replyPath}.reply`
    ),
    reply_sources: normalizeImportedSources(
      replySourcesInput,
      replySourcesPath
    ),
    suggested_user_action: isSuggestedUserAction(reply.suggested_user_action)
      ? reply.suggested_user_action
      : undefined,
    sources: normalizeImportedSources(reply.sources, `${replyPath}.sources`)
  };
}

function normalizeImportedPatchProposal(
  patchProposal: unknown,
  index: number,
  changedStringPaths: Set<string>
): PatchmarkCommentReplyImport["patch_proposals"][number] {
  if (
    !isRecord(patchProposal) ||
    typeof patchProposal.comment_id !== "string" ||
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

  return {
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
  arrayPath: string
): PatchmarkSourceReference[] | undefined {
  if (sources === undefined) {
    return undefined;
  }

  if (!Array.isArray(sources)) {
    throw new Error(
      `Invalid source array at ${arrayPath}. Sources must be arrays of source objects.`
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
  patchProposals: PatchmarkCommentReplyImport["patch_proposals"]
) {
  for (const patchProposal of patchProposals) {
    validateSuggestedTextReferenceDates({
      originalText: patchProposal.original_text,
      sources: patchProposal.suggested_text_sources ?? [],
      suggestedText: patchProposal.suggested_text
    });
  }
}

function normalizeImportedOpenQuestion(
  openQuestion: unknown,
  index: number,
  changedStringPaths: Set<string>
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

  return {
    comment_id: normalizeRequiredProtocolField({
      changedStringPaths,
      fieldName: `${openQuestionPath}.comment_id`,
      value: openQuestion.comment_id
    }),
    question: validateProtocolTextField(
      normalizeRequiredProtocolField({
        changedStringPaths,
        fieldName: `${openQuestionPath}.question`,
        value: openQuestion.question
      }),
      `${openQuestionPath}.question`
    ),
    question_sources: normalizeImportedSources(
      openQuestion.question_sources,
      `${openQuestionPath}.question_sources`
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
  return typeof value === "object" && value !== null;
}

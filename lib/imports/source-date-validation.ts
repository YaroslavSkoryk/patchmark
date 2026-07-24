import type { PatchmarkSourceReference } from "../project/project-types.ts";

export type SourceDatePrecision = "year" | "month" | "day";

export type ParsedSourceDate = {
  earliest: string;
  latest: string;
  precision: SourceDatePrecision;
  value: string;
};

export type VisibleReferenceDateAuditIssue = {
  label: string;
  reason: "missing_publication_date" | "missing_observation_date";
  url: string;
};

export const SOURCE_DATE_REFERENCE_ERROR =
  "Add the source publication date to the reference.";
export const SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR =
  "If no publication date is available, state that and include the observation date.";
export const SOURCE_OBSERVED_AT_ERROR =
  "The source metadata is missing observed_at.";
export const SOURCE_OBSERVATION_REFERENCE_ERROR =
  "Add the source observation date to the reference.";

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
const DATE_VALUE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DYNAMIC_SOURCE_PATTERN =
  /\b(price|prices|pricing|menu|availability|available|sold\s*out|delivery|fee|fees|opening\s*hours|hours|promotion|promotions|promo|store\s*location|locations|live\s+menu|live\s+page)\b/i;
const OBSERVED_ANNOTATION_PATTERN =
  /\b(?:observed|checked|accessed|verified)(?:\s+on)?\s+(?:\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]+\s+\d{4}|\d{4}(?:-\d{2})?(?:-\d{2})?)\b/i;
const PUBLISHED_ANNOTATION_PATTERN =
  /\bpublished\s*:?\s+(?:on\s+)?(?:\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]+\s+\d{4}|\d{4}(?:-\d{2})?(?:-\d{2})?)\b/i;
const UNAVAILABLE_PUBLICATION_PATTERN = /\bpublication date unavailable\b/i;

export function parseSourceDateValue(
  value: string,
  fieldPath: string
): ParsedSourceDate {
  const match = DATE_VALUE_PATTERN.exec(value);

  if (!match) {
    throw new Error(`Invalid source date at ${fieldPath}.`);
  }

  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;

  if (month !== null && (month < 1 || month > 12)) {
    throw new Error(`Invalid source date at ${fieldPath}.`);
  }

  if (day !== null) {
    const maxDay = getMonthLength(year, month ?? 1);

    if (day < 1 || day > maxDay) {
      throw new Error(`Invalid source date at ${fieldPath}.`);
    }
  }

  if (day !== null && month !== null) {
    return {
      earliest: value,
      latest: value,
      precision: "day",
      value
    };
  }

  if (month !== null) {
    return {
      earliest: `${match[1]}-${match[2]}-01`,
      latest: `${match[1]}-${match[2]}-${String(
        getMonthLength(year, month)
      ).padStart(2, "0")}`,
      precision: "month",
      value
    };
  }

  return {
    earliest: `${match[1]}-01-01`,
    latest: `${match[1]}-12-31`,
    precision: "year",
    value
  };
}

export function normalizeSourceDateField({
  fieldPath,
  required,
  value
}: {
  fieldPath: string;
  required: boolean;
  value: unknown;
}): string | null | undefined {
  if (value === undefined) {
    if (required) {
      throw new Error(`The source metadata is missing ${getFieldName(fieldPath)}.`);
    }

    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid source date at ${fieldPath}.`);
  }

  parseSourceDateValue(value, fieldPath);

  return value;
}

export function validateSourceDateOrder({
  observedAt,
  publishedAt,
  sourcePath,
  sourceText,
  updatedAt
}: {
  observedAt: string;
  publishedAt: string | null;
  sourcePath: string;
  sourceText: string;
  updatedAt?: string | null;
}) {
  const observed = parseSourceDateValue(observedAt, `${sourcePath}.observed_at`);

  if (observed.precision !== "day") {
    throw new Error(`Invalid source date at ${sourcePath}.observed_at.`);
  }

  if (publishedAt !== null) {
    const published = parseSourceDateValue(
      publishedAt,
      `${sourcePath}.published_at`
    );

    if (published.earliest > observed.latest) {
      throw new Error("Source published_at cannot be after observed_at.");
    }

    if (
      published.value === observed.value &&
      isLikelyLiveDynamicSource(sourceText)
    ) {
      throw new Error(
        "Do not use observed_at as published_at; use null when publication date is unavailable."
      );
    }

    if (updatedAt) {
      const updated = parseSourceDateValue(updatedAt, `${sourcePath}.updated_at`);

      if (updated.latest < published.earliest) {
        throw new Error("Source updated_at cannot be before published_at.");
      }
    }
  }

  if (updatedAt) {
    const updated = parseSourceDateValue(updatedAt, `${sourcePath}.updated_at`);

    if (updated.earliest > observed.latest) {
      throw new Error("Source updated_at cannot be after observed_at.");
    }
  }
}

export function validateConsistentRepeatedSourceDates(
  sources: PatchmarkSourceReference[]
) {
  const datesByUrl = new Map<
    string,
    Pick<PatchmarkSourceReference, "observed_at" | "published_at" | "updated_at">
  >();

  for (const source of sources) {
    const currentDates = {
      observed_at: source.observed_at,
      published_at: source.published_at,
      updated_at: source.updated_at ?? null
    };
    const previousDates = datesByUrl.get(source.url);

    if (!previousDates) {
      datesByUrl.set(source.url, currentDates);
      continue;
    }

    if (
      previousDates.published_at !== currentDates.published_at ||
      previousDates.updated_at !== currentDates.updated_at ||
      previousDates.observed_at !== currentDates.observed_at
    ) {
      throw new Error("Repeated source URL has conflicting date metadata.");
    }
  }
}

export function validateSuggestedTextReferenceDates({
  originalText,
  sources,
  suggestedText
}: {
  originalText: string;
  sources: PatchmarkSourceReference[];
  suggestedText: string;
}) {
  validateSuggestedTextReferenceDatesInternal({
    originalText,
    sources,
    suggestedText
  });
}

export function validateSuggestedTextReferenceDatesWithCoverage({
  coverageMarkdown,
  originalText,
  sources,
  suggestedText
}: {
  coverageMarkdown: string;
  originalText: string;
  sources: PatchmarkSourceReference[];
  suggestedText: string;
}) {
  validateSuggestedTextReferenceDatesInternal({
    coverageMarkdown,
    originalText,
    sources,
    suggestedText
  });
}

function validateSuggestedTextReferenceDatesInternal({
  coverageMarkdown,
  originalText,
  sources,
  suggestedText
}: {
  coverageMarkdown?: string;
  originalText: string;
  sources: PatchmarkSourceReference[];
  suggestedText: string;
}) {
  const sourceByUrl = new Map(
    sources.map((source) => [normalizeUrl(source.url), source])
  );
  const originalLinkKeys = new Set(
    getMarkdownLinks(originalText).map((link) => link.markdown)
  );

  for (const link of getMarkdownLinks(suggestedText)) {
    if (originalLinkKeys.has(link.markdown)) {
      continue;
    }

    const source = sourceByUrl.get(normalizeUrl(link.url));
    const context = getReferenceContext(suggestedText, link.end);
    const hasPublishedAnnotation = PUBLISHED_ANNOTATION_PATTERN.test(context);
    const hasUnavailableAnnotation =
      UNAVAILABLE_PUBLICATION_PATTERN.test(context);
    const hasObservationAnnotation = hasObservedAnnotation(context);
    const hasDependencyCoverage =
      coverageMarkdown && source
        ? hasVisibleDependencyDateCoverage(coverageMarkdown, source)
        : false;

    if (source?.published_at === null) {
      if (
        (!hasUnavailableAnnotation || !hasObservationAnnotation) &&
        !hasDependencyCoverage
      ) {
        throw new Error(SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR);
      }
      continue;
    }

    if (hasUnavailableAnnotation && !hasObservationAnnotation) {
      throw new Error(SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR);
    }

    if (
      !hasPublishedAnnotation &&
      !hasUnavailableAnnotation &&
      !hasDependencyCoverage
    ) {
      throw new Error(SOURCE_DATE_REFERENCE_ERROR);
    }

    if (
      isTimeSensitiveReference({ context, linkLabel: link.label, source }) &&
      !hasObservationAnnotation &&
      !hasDependencyCoverage
    ) {
      throw new Error(SOURCE_OBSERVATION_REFERENCE_ERROR);
    }
  }
}

export function auditVisibleReferenceDateAnnotations(
  markdown: string
): VisibleReferenceDateAuditIssue[] {
  return getMarkdownLinks(markdown).flatMap((link): VisibleReferenceDateAuditIssue[] => {
    const context = getReferenceContext(markdown, link.end);
    const hasPublicationDate =
      PUBLISHED_ANNOTATION_PATTERN.test(context) ||
      UNAVAILABLE_PUBLICATION_PATTERN.test(context);

    if (!hasPublicationDate) {
      return [
        {
          label: link.label,
          reason: "missing_publication_date" as const,
          url: normalizeUrl(link.url)
        }
      ];
    }

    if (
      isTimeSensitiveReference({ context, linkLabel: link.label }) &&
      !hasObservedAnnotation(context)
    ) {
      return [
        {
          label: link.label,
          reason: "missing_observation_date" as const,
          url: normalizeUrl(link.url)
        }
      ];
    }

    return [];
  });
}

export function hasObservedAnnotation(context: string): boolean {
  return OBSERVED_ANNOTATION_PATTERN.test(context);
}

function getMarkdownLinks(markdown: string): Array<{
  end: number;
  label: string;
  markdown: string;
  start: number;
  url: string;
}> {
  return Array.from(markdown.matchAll(MARKDOWN_LINK_PATTERN), (match) => ({
    end: (match.index ?? 0) + match[0].length,
    label: match[1],
    markdown: match[0],
    start: match.index ?? 0,
    url: match[2]
  }));
}

function getReferenceContext(markdown: string, linkEnd: number): string {
  return markdown.slice(linkEnd, linkEnd + 220);
}

function isTimeSensitiveReference({
  context,
  linkLabel,
  source
}: {
  context: string;
  linkLabel: string;
  source?: PatchmarkSourceReference;
}): boolean {
  return isLikelyLiveDynamicSource(
    [
      context,
      linkLabel,
      source?.title ?? "",
      source?.url ?? "",
      source?.supports ?? "",
      source?.note ?? ""
    ].join(" ")
  );
}

function isLikelyLiveDynamicSource(value: string): boolean {
  return DYNAMIC_SOURCE_PATTERN.test(value);
}

function hasVisibleDependencyDateCoverage(
  markdown: string,
  source: PatchmarkSourceReference
): boolean {
  if (!source.observed_at) {
    return false;
  }

  const hasObservationDate = containsLabeledSourceDate(
    markdown,
    /(?:observed|checked|accessed|verified)(?:\s+on)?/,
    source.observed_at
  );

  if (source.published_at === null) {
    return (
      UNAVAILABLE_PUBLICATION_PATTERN.test(markdown) && hasObservationDate
    );
  }

  if (!source.published_at) {
    return false;
  }

  const hasPublicationDate = containsLabeledSourceDate(
    markdown,
    /published(?:\s+on)?/,
    source.published_at
  );

  return (
    hasPublicationDate &&
    (!isLikelyLiveDynamicSource(
      [
        source.title ?? "",
        source.url,
        source.supports ?? "",
        source.note ?? ""
      ].join(" ")
    ) ||
      hasObservationDate)
  );
}

function containsLabeledSourceDate(
  markdown: string,
  labelPattern: RegExp,
  date: string
): boolean {
  const dateAlternatives = getVisibleSourceDateAlternatives(date)
    .map(escapeRegExp)
    .join("|");

  if (!dateAlternatives) {
    return false;
  }

  return new RegExp(
    `${labelPattern.source}[^.\\n]{0,80}(?:${dateAlternatives})`,
    "i"
  ).test(markdown);
}

function getVisibleSourceDateAlternatives(value: string): string[] {
  const parsed = parseSourceDateValue(value, "source date");

  if (parsed.precision === "year") {
    return [value];
  }

  const [year, monthValue, dayValue] = value.split("-");
  const month = Number(monthValue);
  const monthName = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ][month - 1];

  if (!monthName) {
    return [value];
  }

  if (parsed.precision === "month") {
    return [value, `${monthName} ${year}`];
  }

  const day = Number(dayValue);
  return [
    value,
    `${day} ${monthName} ${year}`,
    `${monthName} ${day}, ${year}`
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function getFieldName(path: string): string {
  return path.split(".").pop() ?? path;
}

function getMonthLength(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }

  return MONTH_LENGTHS[month - 1] ?? 31;
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

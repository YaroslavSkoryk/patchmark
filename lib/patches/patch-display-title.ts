import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";

export type PatchDisplayTitleSource =
  | "display_title"
  | "linked_comment"
  | "target_heading"
  | "reason"
  | "technical";

export type PatchDisplayTitleInfo = {
  isTechnicalFallback: boolean;
  source: PatchDisplayTitleSource;
  title: string;
};

type PatchDisplayTitleOptions = {
  comment?: Pick<PatchmarkComment, "comment"> | null;
  includeGroupPosition?: boolean;
};

const TECHNICAL_PATCH_ID_PATTERN = /\bPM-PATCH-\d+\b/gi;
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\([^)]+\)/g;
const MAX_TITLE_WORDS = 10;

export function getPatchDisplayTitle(
  patch: PatchmarkPatch,
  options: PatchDisplayTitleOptions = {}
): string {
  return getPatchDisplayTitleInfo(patch, options).title;
}

export function getPatchDisplayTitleInfo(
  patch: PatchmarkPatch,
  { comment = null, includeGroupPosition = false }: PatchDisplayTitleOptions = {}
): PatchDisplayTitleInfo {
  const explicitTitle = normalizePatchDisplayTitleCandidate(patch.display_title);

  if (explicitTitle) {
    return {
      isTechnicalFallback: false,
      source: "display_title",
      title: explicitTitle
    };
  }

  const linkedCommentTitle = comment
    ? normalizePatchDisplayTitleCandidate(comment.comment)
    : null;

  if (linkedCommentTitle) {
    return {
      isTechnicalFallback: false,
      source: "linked_comment",
      title: appendPatchGroupPosition({
        includeGroupPosition,
        patch,
        title: linkedCommentTitle
      })
    };
  }

  const targetTitle = createTargetHeadingTitle(patch);

  if (targetTitle) {
    return {
      isTechnicalFallback: false,
      source: "target_heading",
      title: targetTitle
    };
  }

  const reasonTitle = normalizePatchDisplayTitleCandidate(patch.reason);

  if (reasonTitle) {
    return {
      isTechnicalFallback: false,
      source: "reason",
      title: reasonTitle
    };
  }

  return {
    isTechnicalFallback: true,
    source: "technical",
    title: `Patch ${patch.id}`
  };
}

export function getPatchGroupDisplayTitle(
  patches: PatchmarkPatch[],
  comment?: Pick<PatchmarkComment, "comment"> | null
): string {
  const firstPatch = patches[0];

  if (!firstPatch) {
    return "Patch group";
  }

  const commentTitle = comment
    ? normalizePatchDisplayTitleCandidate(comment.comment)
    : null;

  if (commentTitle) {
    return commentTitle;
  }

  return getPatchDisplayTitle(firstPatch);
}

export function normalizePatchDisplayTitleCandidate(
  candidate: unknown
): string | null {
  if (typeof candidate !== "string") {
    return null;
  }

  const withoutMarkup = candidate
    .replace(MARKDOWN_LINK_PATTERN, "$1")
    .replace(URL_PATTERN, "")
    .replace(TECHNICAL_PATCH_ID_PATTERN, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence =
    withoutMarkup.match(/^[^.!?\n]+[.!?]?/)?.[0] ?? withoutMarkup;
  const normalized = toActionTitle(firstSentence)
    .replace(/^[\s:;,\-–—]+|[\s:;,\-–—.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || /^[\W_]*$/.test(normalized)) {
    return null;
  }

  if (/^(?:patch|proposal|change)$/i.test(normalized)) {
    return null;
  }

  return truncateWords(capitalizeFirst(normalized), MAX_TITLE_WORDS);
}

function createTargetHeadingTitle(patch: PatchmarkPatch): string | null {
  const targetHeading = normalizeHeading(patch.target_heading);

  if (!targetHeading) {
    return null;
  }

  return truncateWords(
    `${getPatchActionLabel(patch)} ${targetHeading}`,
    MAX_TITLE_WORDS
  );
}

function getPatchActionLabel(patch: PatchmarkPatch): string {
  if (!patch.original_text.trim() && patch.suggested_text.trim()) {
    return "Add";
  }

  if (patch.original_text.trim() && !patch.suggested_text.trim()) {
    return "Remove";
  }

  return "Update";
}

function normalizeHeading(heading: unknown): string | null {
  if (typeof heading !== "string") {
    return null;
  }

  const normalized = heading
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized ? normalized : null;
}

function appendPatchGroupPosition({
  includeGroupPosition,
  patch,
  title
}: {
  includeGroupPosition: boolean;
  patch: PatchmarkPatch;
  title: string;
}): string {
  if (
    !includeGroupPosition ||
    !patch.patch_group_index ||
    !patch.patch_group_total ||
    patch.patch_group_total <= 1
  ) {
    return title;
  }

  return `${title} · Patch ${patch.patch_group_index} of ${patch.patch_group_total}`;
}

function toActionTitle(title: string): string {
  const imperative = title
    .replace(/^(?:can|could|would)\s+(?:you|we)\s+/i, "")
    .replace(/^please\s+/i, "")
    .replace(/^this\s+patch\s+/i, "")
    .replace(/^the\s+patch\s+/i, "")
    .replace(/^patchmark\s+should\s+/i, "")
    .replace(/^we\s+(?:should|need\s+to|can)\s+/i, "")
    .replace(/^let(?:'|’)s\s+/i, "")
    .replace(/^to\s+/i, "")
    .trim();
  const [firstWord = "", ...remainingWords] = imperative.split(/\s+/);
  const verb = normalizeLeadingVerb(firstWord);

  return [verb, ...remainingWords].filter(Boolean).join(" ");
}

function normalizeLeadingVerb(word: string): string {
  const normalized = word.toLowerCase();
  const verbMap: Record<string, string> = {
    added: "Add",
    adding: "Add",
    adds: "Add",
    clarified: "Clarify",
    clarifies: "Clarify",
    clarifying: "Clarify",
    changed: "Update",
    changes: "Update",
    changing: "Update",
    found: "Find",
    finding: "Find",
    finds: "Find",
    moved: "Move",
    moves: "Move",
    moving: "Move",
    removed: "Remove",
    removes: "Remove",
    removing: "Remove",
    replaced: "Replace",
    replaces: "Replace",
    replacing: "Replace",
    reworked: "Rework",
    reworking: "Rework",
    reworks: "Rework",
    updated: "Update",
    updates: "Update",
    updating: "Update"
  };

  return verbMap[normalized] ?? word;
}

function capitalizeFirst(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : value;
}

function truncateWords(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);

  if (words.length <= maxWords) {
    return value;
  }

  return words.slice(0, maxWords).join(" ");
}

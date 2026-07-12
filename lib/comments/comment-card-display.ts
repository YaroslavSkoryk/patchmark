import type {
  PatchmarkComment,
  PatchmarkCommentAnchor
} from "../project/project-types.ts";

type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;

type SectionAnchor = Extract<PatchmarkCommentAnchor, { kind: "section" }>;

export type CommentCollapsedTarget = {
  primary: string;
  secondary?: string;
  title: string;
  variant: "location" | "selected_text";
};

export function getCollapsedCommentTarget({
  comment,
  fallbackLabel,
  locationLabel
}: {
  comment: PatchmarkComment;
  fallbackLabel: string;
  locationLabel?: string;
}): CommentCollapsedTarget {
  if (comment.anchor.kind === "selected_text") {
    const selectedText = normalizeCollapsedCommentText(
      comment.anchor.selected_text
    );

    if (selectedText) {
      const secondary = locationLabel
        ? cleanMarkdownHeadingText(locationLabel)
        : getSelectedTextLocationLabel(comment.anchor);

      return {
        primary: `“${selectedText}”`,
        secondary: secondary === "document" ? undefined : secondary,
        title: selectedText,
        variant: "selected_text"
      };
    }
  }

  const primary = cleanCommentAnchorLabel(
    locationLabel ?? fallbackLabel ?? getCleanCommentAnchorLabel(comment)
  );

  return {
    primary,
    title: primary,
    variant: "location"
  };
}

export function getCleanCommentAnchorLabel(comment: PatchmarkComment): string {
  if (comment.anchor.kind === "document") {
    return "Whole document";
  }

  if (comment.anchor.kind === "section") {
    return `Whole section: ${getSectionHeadingLabel(comment.anchor)}`;
  }

  return `Selected text in ${getSelectedTextLocationLabel(comment.anchor)}`;
}

export function getSelectedTextLocationLabel(anchor: SelectedTextAnchor): string {
  if (!anchor.containing_heading) {
    return "document";
  }

  return cleanMarkdownHeadingText(anchor.containing_heading);
}

export function getSectionHeadingLabel(anchor: SectionAnchor): string {
  return anchor.heading
    ? cleanMarkdownHeadingText(anchor.heading)
    : "Target section not found";
}

export function cleanCommentAnchorLabel(label: string): string {
  const normalizedLabel = normalizeCollapsedCommentText(label);

  return normalizedLabel
    .replace(
      /^(Whole section:\s*)((?:#{1,6}\s+)+)/i,
      (_match, prefix: string) => prefix
    )
    .replace(
      /^(Selected text in\s*)((?:#{1,6}\s+)+)/i,
      (_match, prefix: string) => prefix
    )
    .replace(/^((?:#{1,6}\s+)+)/, "")
    .replace(/\s((?:#{1,6}\s+){2,})/g, " ");
}

export function cleanMarkdownHeadingText(value: string): string {
  let headingText = normalizeCollapsedCommentText(value);

  while (/^#{1,6}\s+/.test(headingText)) {
    headingText = headingText.replace(/^#{1,6}\s+/, "");
  }

  return headingText || "Target section not found";
}

export function normalizeCollapsedCommentText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

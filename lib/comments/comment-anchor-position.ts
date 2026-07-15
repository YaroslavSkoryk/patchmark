import type {
  PatchmarkComment,
  PatchmarkCommentAnchor
} from "../project/project-types.ts";
import {
  getHistoryAnchorState,
  getHistoryNextAnchor,
  getHistoryPreviousAnchor
} from "./comment-anchor-history.ts";

export type CommentAnchorPositionRange = {
  end: number;
  start: number;
};

export function getLastKnownCommentAnchorPositionRange(
  comment: Pick<PatchmarkComment, "anchor" | "anchor_history">
): CommentAnchorPositionRange | null {
  return (
    getStoredAnchorPositionRange(comment.anchor) ??
    getLastKnownAnchorHistoryPositionRange(comment.anchor_history ?? []) ??
    null
  );
}

export function sortCommentsByLastKnownAnchorPosition<
  Comment extends Pick<
    PatchmarkComment,
    "anchor" | "anchor_history" | "created_at" | "id"
  >
>(comments: Comment[]): Comment[] {
  return [...comments].sort((firstComment, secondComment) => {
    const firstRange = getLastKnownCommentAnchorPositionRange(firstComment);
    const secondRange = getLastKnownCommentAnchorPositionRange(secondComment);
    const firstStart = firstRange?.start ?? Number.POSITIVE_INFINITY;
    const secondStart = secondRange?.start ?? Number.POSITIVE_INFINITY;

    return (
      firstStart - secondStart ||
      firstComment.created_at.localeCompare(secondComment.created_at) ||
      firstComment.id.localeCompare(secondComment.id)
    );
  });
}

function getLastKnownAnchorHistoryPositionRange(
  anchorHistory: NonNullable<PatchmarkComment["anchor_history"]>
): CommentAnchorPositionRange | null {
  for (const entry of [...anchorHistory].reverse()) {
    const newAnchor = getHistoryNextAnchor(entry);
    const newAnchorRange = newAnchor
      ? getStoredAnchorPositionRange(newAnchor)
      : getConciseHistoryPositionRange(entry, "next");

    if (newAnchorRange) {
      return newAnchorRange;
    }

    const previousAnchor = getHistoryPreviousAnchor(entry);
    const previousAnchorRange = previousAnchor
      ? getStoredAnchorPositionRange(previousAnchor)
      : getConciseHistoryPositionRange(entry, "previous");

    if (previousAnchorRange) {
      return previousAnchorRange;
    }
  }

  return null;
}

function getConciseHistoryPositionRange(
  entry: NonNullable<PatchmarkComment["anchor_history"]>[number],
  side: "previous" | "next"
): CommentAnchorPositionRange | null {
  const state = getHistoryAnchorState(entry, side);
  return state
    ? getValidOffsetRange({ end: state.end, start: state.start })
    : null;
}

function getStoredAnchorPositionRange(
  anchor: PatchmarkCommentAnchor
): CommentAnchorPositionRange | null {
  if (anchor.kind === "document") {
    return {
      end: 0,
      start: 0
    };
  }

  if (anchor.kind === "section") {
    return getValidOffsetRange({
      end: anchor.section_end_offset,
      start: anchor.section_start_offset
    });
  }

  return (
    getValidOffsetRange({
      end: anchor.markdown_end_offset,
      start: anchor.markdown_start_offset
    }) ??
    getValidOffsetRange({
      end: anchor.anchor_context?.markdown_end_offset,
      start: anchor.anchor_context?.markdown_start_offset
    }) ??
    getValidOffsetRange({
      end: anchor.fallback_section_end_offset,
      start: anchor.fallback_section_start_offset
    })
  );
}

function getValidOffsetRange({
  end,
  start
}: {
  end?: number;
  start?: number;
}): CommentAnchorPositionRange | null {
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    start < 0
  ) {
    return null;
  }

  return {
    end:
      typeof end === "number" && Number.isFinite(end) && end >= start
        ? end
        : start,
    start
  };
}

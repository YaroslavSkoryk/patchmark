import type {
  PatchmarkComment,
  PatchmarkCommentActionContext,
  PatchmarkCommentAnchor,
  PatchmarkCommentType
} from "../project/project-types.ts";

export function allocatePatchmarkCommentIds(
  comments: ReadonlyArray<Pick<PatchmarkComment, "id">>,
  count: number
): string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Patchmark comment allocation requires a non-negative count.");
  }

  const usedIds = new Set(comments.map((comment) => comment.id));
  let nextNumber =
    comments.reduce((maximum, comment) => {
      const match = /^PM-COMMENT-(\d+)$/.exec(comment.id);

      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) + 1;
  const allocatedIds: string[] = [];

  while (allocatedIds.length < count) {
    const candidate = `PM-COMMENT-${String(nextNumber).padStart(4, "0")}`;
    nextNumber += 1;

    if (usedIds.has(candidate)) {
      continue;
    }

    usedIds.add(candidate);
    allocatedIds.push(candidate);
  }

  return allocatedIds;
}

export function createNativePatchmarkComment({
  anchor,
  comment,
  createdAt,
  id,
  sourceImportId,
  type
}: {
  anchor: PatchmarkCommentAnchor;
  comment: string;
  createdAt: string;
  id: string;
  sourceImportId?: string;
  type: PatchmarkCommentType;
}): PatchmarkComment {
  return {
    id,
    type,
    status: "open",
    anchor,
    comment,
    thread: [],
    export_state: {
      focus_state: "idle"
    },
    ...(sourceImportId ? { source_import_id: sourceImportId } : {}),
    created_at: createdAt,
    updated_at: createdAt
  };
}

export function getDefaultCommentActionContext(
  commentType: PatchmarkCommentType,
  anchorKind: PatchmarkCommentAnchor["kind"]
): PatchmarkCommentActionContext {
  return anchorKind === "document"
    ? {
        default_scope: "full_document",
        include_document_brief: true,
        include_open_comments: "focused_only",
        intent_hint: getActionIntentForCommentType(commentType)
      }
    : {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: getActionIntentForCommentType(commentType)
      };
}

function getActionIntentForCommentType(
  commentType: PatchmarkCommentType
): PatchmarkCommentActionContext["intent_hint"] {
  if (commentType === "question" || commentType === "decision_needed") {
    return "decision";
  }

  if (commentType === "risk") {
    return "risk_review";
  }

  if (commentType === "research_needed") {
    return "research";
  }

  return "note";
}

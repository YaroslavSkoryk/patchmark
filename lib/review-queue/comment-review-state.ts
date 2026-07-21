import type { PatchmarkComment } from "../project/project-types.ts";
import type {
  CommentReviewReasonCode,
  CommentReviewState,
  LatestMeaningfulTurn,
  ReviewQueueActiveExportEvidence,
  ReviewQueueAnchorAvailability
} from "./review-queue-types.ts";

export function deriveCommentReviewState({
  activeExportEvidence,
  anchorAvailability,
  comment,
  deferred,
  latestMeaningfulTurn
}: {
  activeExportEvidence?: ReviewQueueActiveExportEvidence;
  anchorAvailability: ReviewQueueAnchorAvailability;
  comment: PatchmarkComment;
  deferred: boolean;
  latestMeaningfulTurn: LatestMeaningfulTurn;
}): {
  reasonCode: CommentReviewReasonCode;
  state: CommentReviewState;
} {
  if (comment.status === "resolved") {
    return { reasonCode: "resolved", state: "resolved" };
  }

  const exportLifecycle = getExportLifecycleEvidence({
    activeExportEvidence,
    comment,
    latestMeaningfulTurn
  });
  if (exportLifecycle === "active") {
    return {
      reasonCode: "active_exported_request",
      state: "awaiting_chatgpt_response"
    };
  }

  if (comment.status !== "open") {
    return { reasonCode: "unsupported_comment_state", state: "blocked" };
  }

  if (exportLifecycle === "ambiguous") {
    return { reasonCode: "lifecycle_ambiguous", state: "blocked" };
  }

  if (anchorAvailability === "ambiguous") {
    return { reasonCode: "anchor_ambiguous", state: "blocked" };
  }

  if (anchorAvailability === "unresolved") {
    return { reasonCode: "anchor_unresolved", state: "blocked" };
  }

  if (deferred) {
    return { reasonCode: "deferred", state: "deferred" };
  }

  if (latestMeaningfulTurn.actor === "human") {
    return {
      reasonCode: latestMeaningfulTurn.kind,
      state: "ready_for_chatgpt"
    };
  }

  if (latestMeaningfulTurn.actor === "assistant") {
    return {
      reasonCode: latestMeaningfulTurn.kind,
      state: "awaiting_human_review"
    };
  }

  return { reasonCode: "no_meaningful_turn", state: "blocked" };
}

function getExportLifecycleEvidence({
  activeExportEvidence,
  comment,
  latestMeaningfulTurn
}: {
  activeExportEvidence?: ReviewQueueActiveExportEvidence;
  comment: PatchmarkComment;
  latestMeaningfulTurn: LatestMeaningfulTurn;
}): "active" | "ambiguous" | "none" {
  if (activeExportEvidence && !activeExportEvidence.responseImported) {
    return "active";
  }

  const exportState = comment.export_state;
  const exportedAt = parseTimestamp(exportState.last_exported_at);
  const importedAt = parseTimestamp(exportState.last_imported_at);
  const reliableExport = Boolean(exportState.last_export_id && exportedAt !== null);
  const importedAfterExport =
    reliableExport && importedAt !== null && importedAt >= exportedAt!;
  const latestHumanAt =
    latestMeaningfulTurn.actor === "human"
      ? parseTimestamp(latestMeaningfulTurn.occurredAt)
      : null;
  const humanRequestedAfterExport =
    reliableExport && latestHumanAt !== null && latestHumanAt > exportedAt!;

  if (
    exportState.focus_state === "exported" ||
    exportState.focus_state === "awaiting_reply"
  ) {
    if (reliableExport && !importedAfterExport && !humanRequestedAfterExport) {
      return "active";
    }
    return importedAfterExport || humanRequestedAfterExport
      ? "none"
      : "ambiguous";
  }

  if (
    (exportState.last_export_id || exportState.last_exported_at) &&
    !importedAfterExport &&
    !humanRequestedAfterExport
  ) {
    return "ambiguous";
  }

  if (
    exportState.focus_state === "reply_received" &&
    !exportState.last_import_id &&
    latestMeaningfulTurn.actor !== "assistant"
  ) {
    return "ambiguous";
  }

  return "none";
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

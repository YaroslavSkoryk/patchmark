import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import type {
  LatestMeaningfulTurn,
  ReviewQueueFollowUpEvidence
} from "./review-queue-types.ts";

type MeaningfulTurnEvent = Exclude<
  LatestMeaningfulTurn,
  { actor: "none" }
> & {
  fallbackOrder: number;
};

export type MeaningfulTurnResult = {
  explicitFollowUp: boolean;
  latestTurn: LatestMeaningfulTurn;
};

export function deriveLatestMeaningfulTurn({
  comment,
  explicitFollowUps = [],
  patches
}: {
  comment: PatchmarkComment;
  explicitFollowUps?: ReviewQueueFollowUpEvidence[];
  patches: PatchmarkPatch[];
}): MeaningfulTurnResult {
  const events: MeaningfulTurnEvent[] = [
    {
      actor: "human",
      fallbackOrder: 0,
      kind: "new_comment",
      occurredAt: comment.created_at,
      sourceId: comment.id
    }
  ];

  comment.thread.forEach((entry, index) => {
    if (entry.role === "user") {
      events.push({
        actor: "human",
        fallbackOrder: 1_000 + index,
        kind: entry.source_patch_id ? "continue_discussion" : "human_reply",
        occurredAt: entry.updated_at ?? entry.created_at,
        sourceId: entry.id
      });
    } else if (entry.role === "chatgpt") {
      events.push({
        actor: "assistant",
        fallbackOrder: 1_000 + index,
        kind:
          entry.suggested_user_action === "clarify"
            ? "clarification_question"
            : "assistant_reply",
        occurredAt: entry.updated_at ?? entry.created_at,
        sourceId: entry.id
      });
    }
  });

  const linkedPatches = patches
    .filter((patch) => patch.comment_id === comment.id)
    .sort(comparePatchFallbackOrder);
  linkedPatches.forEach((patch, index) => {
    events.push({
      actor: "assistant",
      fallbackOrder: 2_000 + index,
      kind: "patch_proposal",
      occurredAt: patch.created_at,
      sourceId: patch.id
    });
  });

  const importedArtifactIds = new Set([
    ...comment.thread
      .filter((entry) => entry.role === "chatgpt")
      .map((entry) => entry.source_import_id)
      .filter((value): value is string => Boolean(value)),
    ...linkedPatches
      .map((patch) => patch.source_import_id)
      .filter((value): value is string => Boolean(value))
  ]);
  if (
    comment.export_state.last_imported_at &&
    comment.export_state.last_import_id &&
    !importedArtifactIds.has(comment.export_state.last_import_id)
  ) {
    events.push({
      actor: "assistant",
      fallbackOrder: 3_000,
      kind: "explicit_no_change",
      occurredAt: comment.export_state.last_imported_at,
      sourceId: comment.export_state.last_import_id
    });
  }

  explicitFollowUps.forEach((followUp, index) => {
    if (followUp.commentId !== comment.id) {
      return;
    }
    events.push({
      actor: "human",
      fallbackOrder: 4_000 + index,
      kind: followUp.kind,
      occurredAt: followUp.requestedAt,
      sourceId: followUp.sourceId
    });
  });

  events.sort(compareMeaningfulTurnEvents);
  const latestEvent = events.at(-1);
  if (!latestEvent) {
    return {
      explicitFollowUp: false,
      latestTurn: { actor: "none", kind: "no_meaningful_turn" }
    };
  }

  const assistantBeforeLatest = events.some(
    (event) =>
      event.actor === "assistant" &&
      compareMeaningfulTurnEvents(event, latestEvent) < 0
  );
  const explicitFollowUp =
    latestEvent.actor === "human" &&
    (latestEvent.kind === "continue_discussion" ||
      latestEvent.kind === "explicit_assistant_request" ||
      (latestEvent.kind === "human_reply" && assistantBeforeLatest));

  return {
    explicitFollowUp,
    latestTurn: stripFallbackOrder(latestEvent)
  };
}

function compareMeaningfulTurnEvents(
  first: MeaningfulTurnEvent,
  second: MeaningfulTurnEvent
): number {
  const firstTimestamp = parseTimestamp(first.occurredAt);
  const secondTimestamp = parseTimestamp(second.occurredAt);

  if (
    firstTimestamp !== null &&
    secondTimestamp !== null &&
    firstTimestamp !== secondTimestamp
  ) {
    return firstTimestamp - secondTimestamp;
  }

  return (
    first.fallbackOrder - second.fallbackOrder ||
    first.sourceId.localeCompare(second.sourceId)
  );
}

function comparePatchFallbackOrder(
  first: PatchmarkPatch,
  second: PatchmarkPatch
): number {
  const firstTimestamp = parseTimestamp(first.created_at);
  const secondTimestamp = parseTimestamp(second.created_at);
  return (
    (firstTimestamp ?? Number.POSITIVE_INFINITY) -
      (secondTimestamp ?? Number.POSITIVE_INFINITY) ||
    first.id.localeCompare(second.id)
  );
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripFallbackOrder(
  event: MeaningfulTurnEvent
): Exclude<LatestMeaningfulTurn, { actor: "none" }> {
  if (event.actor === "human") {
    return {
      actor: event.actor,
      kind: event.kind,
      occurredAt: event.occurredAt,
      sourceId: event.sourceId
    };
  }
  return {
    actor: event.actor,
    kind: event.kind,
    occurredAt: event.occurredAt,
    sourceId: event.sourceId
  };
}

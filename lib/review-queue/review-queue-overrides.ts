import {
  commitProjectReviewQueueOverridesUpdate,
  getProjectDocumentIdentity,
  readProjectReviewQueueOverrides,
  type PatchmarkProjectHandle
} from "../project/patchmark-project.ts";
import type { PatchmarkComment } from "../project/project-types.ts";
import type { PatchmarkReviewQueueOverrides } from "./review-queue-override-types.ts";

export async function getReviewQueueOverrides(
  project: PatchmarkProjectHandle
): Promise<PatchmarkReviewQueueOverrides> {
  return readProjectReviewQueueOverrides(project);
}

export function getDeferredReviewCommentIds(
  overrides: PatchmarkReviewQueueOverrides
): Set<string> {
  return new Set(
    overrides.deferred_comments.map((entry) => entry.comment_id)
  );
}

export async function deferReviewComment({
  commentId,
  comments,
  deferredAt,
  expectedDocumentGeneration,
  project,
  reason = null
}: {
  commentId: string;
  comments: PatchmarkComment[];
  deferredAt: string;
  expectedDocumentGeneration: number;
  project: PatchmarkProjectHandle;
  reason?: string | null;
}): Promise<PatchmarkReviewQueueOverrides> {
  const comment = comments.find((candidate) => candidate.id === commentId);
  if (!comment || comment.status !== "open") {
    throw new Error("Only an existing open comment can be deferred.");
  }
  return commitProjectReviewQueueOverridesUpdate({
    project,
    reason: `defer_review_comment:${commentId}`,
    update: (current) => {
      assertExpectedGeneration(project, expectedDocumentGeneration);
      if (
        current.deferred_comments.some(
          (entry) => entry.comment_id === commentId
        )
      ) {
        return current;
      }
      return {
        ...current,
        deferred_comments: [
          ...current.deferred_comments,
          { comment_id: commentId, deferred_at: deferredAt, reason }
        ]
      };
    }
  });
}

export async function restoreDeferredReviewComment({
  commentId,
  expectedDocumentGeneration,
  project
}: {
  commentId: string;
  expectedDocumentGeneration: number;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkReviewQueueOverrides> {
  return commitProjectReviewQueueOverridesUpdate({
    project,
    reason: `restore_deferred_review_comment:${commentId}`,
    update: (current) => {
      assertExpectedGeneration(project, expectedDocumentGeneration);
      if (
        !current.deferred_comments.some(
          (entry) => entry.comment_id === commentId
        )
      ) {
        return current;
      }
      return {
        ...current,
        deferred_comments: current.deferred_comments.filter(
          (entry) => entry.comment_id !== commentId
        )
      };
    }
  });
}

function assertExpectedGeneration(
  project: PatchmarkProjectHandle,
  expectedDocumentGeneration: number
): void {
  const identity = getProjectDocumentIdentity(project);
  if (project.persistence.generation !== expectedDocumentGeneration) {
    throw new Error(
      `The Guided Review state for ${identity.documentId} changed. Refresh the queue and try again.`
    );
  }
}

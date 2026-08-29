import {
  getPatchDisplayTitleInfo,
  normalizePatchDisplayTitleCandidate
} from "../patches/patch-display-title.ts";
import {
  PatchDependencyValidationError,
  validateImportedPatchDependencySimulation
} from "../patches/patch-dependencies.ts";
import { validateAtomicTablePatchImport } from "../patches/atomic-table-patches.ts";
import {
  getProjectDocumentExportIdentity,
  getProjectDocumentIdentity,
  readProjectPatches,
  removeProjectImport,
  saveProjectState,
  writeProjectImport,
  type PatchmarkProjectHandle
} from "../project/patchmark-project.ts";
import type {
  PatchmarkComment,
  PatchmarkCommentReplyImport,
  PatchmarkCommentThreadEntry,
  PatchmarkPatch,
  PatchmarkSourceReference,
  PatchmarkSuggestedUserAction
} from "../project/project-types.ts";
import {
  readExactReviewBatchDocumentSnapshot
} from "../review-batches/review-batch-export.ts";
import {
  createRespondedReviewBatchRecords
} from "../review-batches/review-batch-progression.ts";
import {
  associateReviewBatchResponse,
  validateExactReviewBatchResponseComments
} from "../review-batches/review-batch-response-receipt.ts";
import { getActiveReviewBatch } from "../review-batches/review-batch-repository.ts";
import {
  analyzeImportedReviewBatchResponse
} from "../review-batches/review-response-analysis.ts";
import type { PatchmarkReviewBatch } from "../review-batches/review-batch-types.ts";
import { createContentSha256 } from "../storage/document-recovery-storage.ts";
import {
  normalizeSourceChatUrl,
  parsePatchmarkCommentReplyImport
} from "./patchmark-comment-reply-import.ts";

export type ProjectCommentReplyImportResult = Readonly<{
  comments: PatchmarkComment[];
  import_id: string;
  import_relative_path: string;
  imported_at: string;
  open_questions_attached: number;
  patches: PatchmarkPatch[];
  patch_proposals_stored: number;
  replies_attached: number;
  review_batches: PatchmarkReviewBatch[];
  warnings: string[];
}>;

export async function importProjectCommentReplyResponseBytes(
  input: Omit<ProjectCommentReplyImportInput, "responseText"> & {
    responseBytes: Uint8Array;
  }
): Promise<ProjectCommentReplyImportResult> {
  let responseText: string;
  try {
    responseText = new TextDecoder("utf-8", { fatal: true }).decode(
      input.responseBytes
    );
  } catch {
    throw new Error("Invalid Patchmark response. Expected UTF-8 JSON bytes.");
  }
  return importProjectCommentReplyResponse({ ...input, responseText });
}

export type ProjectCommentReplyImportInput = Readonly<{
  comments: PatchmarkComment[];
  importedAt?: string;
  importId?: string;
  expectedProtocolVersion?: 1 | 2;
  knownCommentIds: ReadonlySet<string>;
  markdown: string;
  project: PatchmarkProjectHandle;
  responseText: string;
  reviewBatches: PatchmarkReviewBatch[];
  sourceChatUrl?: string;
  validateBeforeCommit?: () => void;
}>;

/**
 * The authoritative comment/reply/patch response-import boundary shared by the
 * manual workflow and non-authoritative transports. It parses and plans before
 * committing comments, patches, and Review Batch state atomically.
 */
export async function importProjectCommentReplyResponse({
  comments,
  importedAt = new Date().toISOString(),
  importId = createCommentImportId(importedAt),
  expectedProtocolVersion,
  knownCommentIds,
  markdown,
  project,
  responseText,
  reviewBatches,
  sourceChatUrl,
  validateBeforeCommit
}: ProjectCommentReplyImportInput): Promise<ProjectCommentReplyImportResult> {
  validateBeforeCommit?.();
  const parsedResponse = parsePatchmarkCommentReplyImport(responseText);
  if (
    expectedProtocolVersion !== undefined &&
    parsedResponse.protocol_version !== expectedProtocolVersion
  ) {
    throw new Error(
      `Invalid Patchmark response. Expected protocol_version ${expectedProtocolVersion}.`
    );
  }
  const responseAssociation = associateReviewBatchResponse({
    batches: reviewBatches,
    response: parsedResponse,
    target: getProjectDocumentIdentity(project)
  });
  let dependencyBaseDocumentState: "changed" | "current" | "unknown" =
    "unknown";
  let dependencyValidationMarkdown = markdown;

  if (responseAssociation.kind === "exact") {
    validateExactReviewBatchResponseComments({
      batch: responseAssociation.batch,
      response: parsedResponse
    });
    dependencyValidationMarkdown = (
      await readExactReviewBatchDocumentSnapshot({
        batch: responseAssociation.batch,
        currentMarkdown: markdown,
        project
      })
    ).markdown;
    dependencyBaseDocumentState = "current";
  }
  validateAtomicTablePatchImport({
    markdown: dependencyValidationMarkdown,
    patchProposals: parsedResponse.patch_proposals
  });
  const dependencyBaseDocumentSha256 = await createContentSha256(
    dependencyValidationMarkdown
  );
  const normalizedSourceChatUrl = normalizeSourceChatUrl(sourceChatUrl ?? "");
  validateBeforeCommit?.();

  const existingPatches = await readProjectPatches(project);
  const importedPatches = createImportedPatchProposals({
    comments,
    existingPatches,
    importedAt,
    importId,
    knownCommentIds,
    patchProposals: parsedResponse.patch_proposals,
    sourceChatUrl: normalizedSourceChatUrl
  });
  validateImportedPatchDependencySimulation({
    baseDocumentSha256: dependencyBaseDocumentSha256,
    baseDocumentState: dependencyBaseDocumentState,
    comments,
    documentId: getProjectDocumentIdentity(project).documentId,
    existingPatches:
      responseAssociation.kind === "exact" ? [] : existingPatches,
    importedPatches,
    markdown: dependencyValidationMarkdown
  });
  const importedCommentIds = getKnownImportCommentIds(
    parsedResponse,
    knownCommentIds
  );
  const { nextComments, openQuestionsAttached, repliesAttached } =
    createImportedCommentThreads({
      comments,
      importedAt,
      importId,
      importedCommentIds,
      openQuestions: parsedResponse.open_questions,
      replies: parsedResponse.replies,
      sourceChatUrl: normalizedSourceChatUrl
    });
  const importWarnings = getUnknownImportCommentIds(
    parsedResponse,
    knownCommentIds
  ).map(
    (commentId) =>
      `Response referenced a comment that was not found: ${commentId}`
  );
  if (
    getActiveReviewBatch(reviewBatches) &&
    responseAssociation.kind !== "exact"
  ) {
    importWarnings.push(
      "The response did not include exact Review Batch identity. The active batch remains awaiting an associated response."
    );
  }

  const nextPatches = [...existingPatches, ...importedPatches];
  const responseAnalysis =
    responseAssociation.kind === "exact"
      ? analyzeImportedReviewBatchResponse({
          analyzedAt: importedAt,
          batch: responseAssociation.batch,
          comments: nextComments,
          importId,
          patches: nextPatches
        })
      : null;
  const nextReviewBatches =
    responseAssociation.kind === "exact" && responseAnalysis
      ? createRespondedReviewBatchRecords({
          analysis: responseAnalysis,
          batchId: responseAssociation.batch.batch_id,
          batches: reviewBatches,
          importId,
          responseReceivedAt: importedAt
        })
      : reviewBatches;
  const importWrapper = {
    import_id: importId,
    imported_at: importedAt,
    target_document: getProjectDocumentExportIdentity(project),
    source_chat_url: normalizedSourceChatUrl,
    sources: parsedResponse.sources,
    raw_response: parsedResponse,
    warnings: importWarnings
  };

  validateBeforeCommit?.();
  const importWrite = await writeProjectImport({
    contents: `${JSON.stringify(importWrapper, null, 2)}\n`,
    fileName: `${createFileSafeTimestamp(importedAt)}-comment-reply-import.json`,
    project
  });

  try {
    await saveProjectState({
      comments: nextComments,
      markdown,
      patches: nextPatches,
      reviewBatches: nextReviewBatches,
      project,
      reason: "import_chatgpt_response",
      rollbackOnFailure: true,
      validateBeforeCommit
    });
  } catch (error) {
    await removeProjectImport({
      project,
      relativePath: importWrite.relativePath,
      removeEmptyDirectory: importWrite.createdDirectory
    }).catch(() => false);
    throw error;
  }

  return Object.freeze({
    comments: nextComments,
    import_id: importId,
    import_relative_path: importWrite.relativePath,
    imported_at: importedAt,
    open_questions_attached: openQuestionsAttached,
    patches: nextPatches,
    patch_proposals_stored: importedPatches.length,
    replies_attached: repliesAttached,
    review_batches: nextReviewBatches,
    warnings: importWarnings
  });
}

function createCommentImportId(importedAt: string): string {
  return `PM-IMPORT-${createFileSafeTimestamp(importedAt)}`;
}

function createFileSafeTimestamp(value: string): string {
  return value
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "-$1")
    .replace("T", "-")
    .replace("Z", "");
}

function getUnknownImportCommentIds(
  response: PatchmarkCommentReplyImport,
  knownCommentIds: ReadonlySet<string>
): string[] {
  return Array.from(
    new Set(
      getReferencedCommentIds(response).filter(
        (commentId) => !knownCommentIds.has(commentId)
      )
    )
  );
}

function getKnownImportCommentIds(
  response: PatchmarkCommentReplyImport,
  knownCommentIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    getReferencedCommentIds(response).filter((commentId) =>
      knownCommentIds.has(commentId)
    )
  );
}

function getReferencedCommentIds(
  response: PatchmarkCommentReplyImport
): string[] {
  return [
    ...response.replies.map((reply) => reply.comment_id),
    ...response.patch_proposals.map((patch) => patch.comment_id),
    ...response.open_questions.map((question) => question.comment_id)
  ];
}

function createImportedCommentThreads({
  comments,
  importedAt,
  importId,
  importedCommentIds,
  openQuestions,
  replies,
  sourceChatUrl
}: {
  comments: PatchmarkComment[];
  importedAt: string;
  importId: string;
  importedCommentIds: Set<string>;
  openQuestions: PatchmarkCommentReplyImport["open_questions"];
  replies: PatchmarkCommentReplyImport["replies"];
  sourceChatUrl?: string;
}): {
  nextComments: PatchmarkComment[];
  openQuestionsAttached: number;
  repliesAttached: number;
} {
  let openQuestionsAttached = 0;
  let repliesAttached = 0;
  const nextComments = comments.map((comment) => {
    const matchingReplies = replies.filter(
      (reply) => reply.comment_id === comment.id
    );
    const matchingQuestions = openQuestions.filter(
      (question) => question.comment_id === comment.id
    );
    if (
      matchingReplies.length === 0 &&
      matchingQuestions.length === 0 &&
      !importedCommentIds.has(comment.id)
    ) {
      return comment;
    }

    let nextThread = comment.thread;
    for (const reply of matchingReplies) {
      nextThread = [
        ...nextThread,
        createAgentThreadEntry({
          content: reply.reply,
          createdAt: importedAt,
          importId,
          sources: reply.reply_sources,
          sourceChatUrl,
          suggestedUserAction: reply.suggested_user_action,
          thread: nextThread
        })
      ];
      repliesAttached += 1;
    }
    for (const question of matchingQuestions) {
      nextThread = [
        ...nextThread,
        createAgentThreadEntry({
          content: `Question: ${question.question}`,
          createdAt: importedAt,
          importId,
          sources: question.question_sources,
          sourceChatUrl,
          suggestedUserAction: "clarify",
          thread: nextThread
        })
      ];
      openQuestionsAttached += 1;
    }

    return {
      ...comment,
      thread: nextThread,
      export_state: {
        ...comment.export_state,
        focus_state: "reply_received" as const,
        marked_for_export_at: undefined,
        last_imported_at: importedAt,
        last_import_id: importId
      },
      updated_at: importedAt
    };
  });
  return { nextComments, openQuestionsAttached, repliesAttached };
}

function createAgentThreadEntry({
  content,
  createdAt,
  importId,
  sources,
  sourceChatUrl,
  suggestedUserAction,
  thread
}: {
  content: string;
  createdAt: string;
  importId: string;
  sources?: PatchmarkSourceReference[];
  sourceChatUrl?: string;
  suggestedUserAction?: PatchmarkSuggestedUserAction;
  thread: PatchmarkCommentThreadEntry[];
}): PatchmarkCommentThreadEntry {
  return {
    id: createNextThreadEntryId(thread),
    role: "chatgpt",
    content,
    created_at: createdAt,
    sources,
    source_import_id: importId,
    source_chat_url: sourceChatUrl,
    suggested_user_action: suggestedUserAction
  };
}

function createImportedPatchProposals({
  comments,
  existingPatches,
  importedAt,
  importId,
  knownCommentIds,
  patchProposals,
  sourceChatUrl
}: {
  comments: PatchmarkComment[];
  existingPatches: PatchmarkPatch[];
  importedAt: string;
  importId: string;
  knownCommentIds: ReadonlySet<string>;
  patchProposals: PatchmarkCommentReplyImport["patch_proposals"];
  sourceChatUrl?: string;
}): PatchmarkPatch[] {
  const validProposals = patchProposals.filter((proposal) =>
    knownCommentIds.has(proposal.comment_id)
  );
  const groupIdsByCommentId = new Map<string, string>();
  validProposals.forEach((proposal) => {
    if (!groupIdsByCommentId.has(proposal.comment_id)) {
      groupIdsByCommentId.set(
        proposal.comment_id,
        createNextPatchGroupId(existingPatches, groupIdsByCommentId.size)
      );
    }
  });
  const groupTotals = validProposals.reduce<Map<string, number>>(
    (totals, proposal) => {
      totals.set(proposal.comment_id, (totals.get(proposal.comment_id) ?? 0) + 1);
      return totals;
    },
    new Map()
  );
  const groupIndexes = new Map<string, number>();
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  const patchIdsByKey = new Map(
    validProposals.flatMap((proposal, index) =>
      proposal.patch_key
        ? [[proposal.patch_key, createNextPatchId(existingPatches, index)]]
        : []
    )
  );

  return validProposals.map((proposal, index) => {
    const groupIndex = (groupIndexes.get(proposal.comment_id) ?? 0) + 1;
    groupIndexes.set(proposal.comment_id, groupIndex);
    const patch: PatchmarkPatch = {
      id: createNextPatchId(existingPatches, index),
      status: "pending",
      patch_group_id: groupIdsByCommentId.get(proposal.comment_id),
      patch_group_index: groupIndex,
      patch_group_total: groupTotals.get(proposal.comment_id) ?? 1,
      comment_id: proposal.comment_id,
      source_import_id: importId,
      source_chat_url: sourceChatUrl,
      source_patch_key: proposal.patch_key,
      depends_on_patch_ids: proposal.depends_on?.map((dependencyKey) => {
        const dependencyPatchId = patchIdsByKey.get(dependencyKey);
        if (!dependencyPatchId) {
          throw new PatchDependencyValidationError({
            code: "missing_patch_dependency",
            dependencyKey,
            message: `Patch ${proposal.patch_key ?? index + 1} references a dependency that was not assigned an internal patch ID.`,
            patchKey: proposal.patch_key
          });
        }
        return dependencyPatchId;
      }),
      depends_on_patch_keys_snapshot: proposal.depends_on
        ? [...proposal.depends_on]
        : undefined,
      display_title: proposal.display_title,
      target_heading: proposal.target_heading,
      original_text: proposal.original_text,
      suggested_text: proposal.suggested_text,
      suggested_text_sources: proposal.suggested_text_sources,
      reason: proposal.reason,
      reason_sources: proposal.reason_sources,
      risk: proposal.risk,
      risk_sources: proposal.risk_sources,
      sources: proposal.sources,
      created_at: importedAt
    };
    return {
      ...patch,
      display_title:
        patch.display_title ??
        normalizePatchDisplayTitleCandidate(
          getPatchDisplayTitleInfo(patch, {
            comment: commentsById.get(proposal.comment_id) ?? null
          }).title
        ) ??
        undefined
    };
  });
}

function createNextThreadEntryId(thread: PatchmarkCommentThreadEntry[]): string {
  const nextNumber =
    thread.reduce((maximum, entry) => {
      const match = /^PM-THREAD-(\d+)$/.exec(entry.id);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) + 1;
  return `PM-THREAD-${String(nextNumber).padStart(4, "0")}`;
}

function createNextPatchId(patches: PatchmarkPatch[], offset: number): string {
  const nextNumber =
    patches.reduce((maximum, patch) => {
      const match = /^PM-PATCH-(\d+)$/.exec(patch.id);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) +
    offset +
    1;
  return `PM-PATCH-${String(nextNumber).padStart(4, "0")}`;
}

function createNextPatchGroupId(
  patches: PatchmarkPatch[],
  offset: number
): string {
  const nextNumber =
    patches.reduce((maximum, patch) => {
      const match = /^PM-PATCH-GROUP-(\d+)$/.exec(patch.patch_group_id ?? "");
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) +
    offset +
    1;
  return `PM-PATCH-GROUP-${String(nextNumber).padStart(4, "0")}`;
}

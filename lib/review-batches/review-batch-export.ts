import { resolveCanonicalCommentTarget } from "../comments/canonical-target-resolution.ts";
import { parseMarkdownHeadings } from "../markdown/parse-headings.ts";
import { estimateCompletePromptTokens } from "../review-queue/prompt-preview-estimator.ts";
import { REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS } from "../review-queue/review-queue-types.ts";
import {
  getProjectDocumentIdentity,
  readProjectContextPack,
  removeProjectContextPack,
  writeProjectContextPack,
  type PatchmarkProjectHandle
} from "../project/patchmark-project.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import {
  createReviewBatchCommentFingerprint,
  createReviewBatchSha256
} from "./review-batch-fingerprints.ts";
import { createReviewBatchRecord } from "./review-batch-repository.ts";
import {
  REVIEW_BATCH_PROMPT_BUILDER_VERSION,
  REVIEW_BATCH_SCHEMA_VERSION,
  type PatchmarkReviewBatch,
  type ReviewBatchPromptEnvelope,
  type ReviewBatchSelectionAdjustment,
  type ReviewBatchSectionSnapshot,
  type ReviewBatchSource,
  type ReviewBatchType
} from "./review-batch-types.ts";

export type TrackedReviewBatchExportResult = {
  batch: PatchmarkReviewBatch;
  batches: PatchmarkReviewBatch[];
  jsonText?: string;
  promptText: string;
};

export async function createTrackedReviewBatchExport({
  algorithmVersion,
  batchId = createReviewBatchId(),
  batchType,
  buildPrompt,
  comments,
  documentGeneration,
  documentTitle,
  markdown,
  now = new Date().toISOString(),
  overLimitWarning,
  patches,
  project,
  section,
  selectionAdjustment,
  source,
  validateBeforeCommit
}: {
  algorithmVersion: number | null;
  batchId?: string;
  batchType: ReviewBatchType;
  buildPrompt: (envelope: ReviewBatchPromptEnvelope) => {
    jsonText?: string;
    promptText: string;
  };
  comments: PatchmarkComment[];
  documentGeneration: number;
  documentTitle: string;
  markdown: string;
  now?: string;
  overLimitWarning: boolean;
  patches: PatchmarkPatch[];
  project: PatchmarkProjectHandle;
  section: ReviewBatchSectionSnapshot | null;
  selectionAdjustment?: ReviewBatchSelectionAdjustment;
  source: ReviewBatchSource;
  validateBeforeCommit?: () => void;
}): Promise<TrackedReviewBatchExportResult> {
  validateReviewBatchSelection({
    batchType,
    comments,
    markdown,
    patches,
    section,
    source
  });
  validateBeforeCommit?.();
  const identity = getProjectDocumentIdentity(project);
  const orderedCommentIds = comments.map((comment) => comment.id);
  const envelope: ReviewBatchPromptEnvelope = {
    review_batch_id: batchId,
    project_id: identity.projectId,
    document_id: identity.documentId,
    ordered_comment_ids: orderedCommentIds
  };
  const documentContentSha256 = await createReviewBatchSha256(markdown);
  const commentFingerprints = await Promise.all(
    comments.map(async (comment) => ({
      comment_id: comment.id,
      fingerprint: await createReviewBatchCommentFingerprint(comment)
    }))
  );
  const builtPrompt = buildPrompt(envelope);
  const estimatedPromptTokens = estimateCompletePromptTokens(
    builtPrompt.promptText
  );
  const promptSha256 = await createReviewBatchSha256(builtPrompt.promptText);
  const fileName = createReviewBatchContextPackFileName({
    batchId,
    exportedAt: now,
    source
  });
  const relativePath = await writeProjectContextPack({
    contents: builtPrompt.promptText,
    fileName,
    project
  });
  const writtenPrompt = await readProjectContextPack({ project, relativePath });
  const writtenSha256 = await createReviewBatchSha256(writtenPrompt);
  if (
    writtenPrompt !== builtPrompt.promptText ||
    writtenSha256 !== promptSha256
  ) {
    await removeProjectContextPack({ project, relativePath }).catch(
      () => false
    );
    throw new Error("The written Review Batch context pack could not be verified.");
  }
  const batch: PatchmarkReviewBatch = {
    schema_version: REVIEW_BATCH_SCHEMA_VERSION,
    batch_id: batchId,
    project_id: identity.projectId,
    document_id: identity.documentId,
    source,
    batch_type: batchType,
    ordered_comment_ids: orderedCommentIds,
    section,
    ...(selectionAdjustment
      ? { selection_adjustment: selectionAdjustment }
      : {}),
    algorithm_version: algorithmVersion,
    prompt_builder_version: REVIEW_BATCH_PROMPT_BUILDER_VERSION,
    document_generation: documentGeneration,
    batch_record_generation: documentGeneration + 1,
    document_content_sha256: documentContentSha256,
    comment_fingerprints: commentFingerprints,
    estimated_prompt_tokens: estimatedPromptTokens,
    over_limit_warning:
      overLimitWarning ||
      estimatedPromptTokens > REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS,
    prompt_sha256: promptSha256,
    context_pack: {
      relative_path: relativePath,
      content_sha256: writtenSha256,
      bytes: new TextEncoder().encode(writtenPrompt).byteLength
    },
    document_title_snapshot: documentTitle,
    status: "exported",
    created_at: now,
    exported_at: now,
    response_received_at: null,
    acknowledged_at: null,
    cancelled_at: null,
    cancel_reason: null,
    import_id: null,
    response_analysis: null
  };
  try {
    const batches = await createReviewBatchRecord({
      batch,
      expectedDocumentGeneration: documentGeneration,
      project,
      validateBeforeCommit
    });
    return {
      batch,
      batches,
      jsonText: builtPrompt.jsonText,
      promptText: writtenPrompt
    };
  } catch (error) {
    await removeProjectContextPack({ project, relativePath }).catch(
      () => false
    );
    throw error;
  }
}

export async function readExactReviewBatchPrompt({
  batch,
  project
}: {
  batch: PatchmarkReviewBatch;
  project: PatchmarkProjectHandle;
}): Promise<string> {
  const identity = getProjectDocumentIdentity(project);
  if (
    batch.project_id !== identity.projectId ||
    batch.document_id !== identity.documentId
  ) {
    throw new Error("The Review Batch context pack belongs to another document.");
  }
  const prompt = await readProjectContextPack({
    project,
    relativePath: batch.context_pack.relative_path
  });
  const bytes = new TextEncoder().encode(prompt).byteLength;
  const sha256 = await createReviewBatchSha256(prompt);
  if (
    bytes !== batch.context_pack.bytes ||
    sha256 !== batch.context_pack.content_sha256 ||
    sha256 !== batch.prompt_sha256
  ) {
    throw new Error(
      "The saved Review Batch context pack is missing or no longer matches its fingerprint. Cancel the batch before exporting a replacement."
    );
  }
  return prompt;
}

export function createReviewBatchId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (!randomUuid) {
    throw new Error("Secure Review Batch ID generation is unavailable.");
  }
  return `review_batch_${randomUuid}`;
}

function createReviewBatchContextPackFileName({
  batchId,
  exportedAt,
  source
}: {
  batchId: string;
  exportedAt: string;
  source: ReviewBatchSource;
}): string {
  const timestamp = exportedAt
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "-$1")
    .replace("T", "-")
    .replace("Z", "");
  return `${timestamp}-${source}-${batchId}-prompt.md`;
}

function validateReviewBatchSelection({
  batchType,
  comments,
  markdown,
  patches,
  section,
  source
}: {
  batchType: ReviewBatchType;
  comments: PatchmarkComment[];
  markdown: string;
  patches: PatchmarkPatch[];
  section: ReviewBatchSectionSnapshot | null;
  source: ReviewBatchSource;
}): void {
  if (comments.length === 0 || new Set(comments.map((comment) => comment.id)).size !== comments.length) {
    throw new Error("A tracked export requires unique selected comments.");
  }
  if (
    (source === "manual" && batchType !== "manual") ||
    (source === "guided_review" && batchType === "manual") ||
    (batchType === "section") !== Boolean(section)
  ) {
    throw new Error("The Review Batch source, type, or section is invalid.");
  }
  const headings = parseMarkdownHeadings(markdown);
  comments.forEach((comment) => {
    if (comment.status !== "open") {
      throw new Error(`Comment ${comment.id} is no longer open.`);
    }
    const resolution = resolveCanonicalCommentTarget(comment, {
      headings,
      markdown,
      patches
    });
    if (comment.anchor.kind !== "document" && resolution.state !== "resolved") {
      throw new Error(
        `Comment ${comment.id} no longer has a usable anchor (${resolution.state}).`
      );
    }
  });
}

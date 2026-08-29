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
  const contextPackFileName = createReviewBatchContextPackFileName({
    batchId,
    exportedAt: now,
    source
  });
  const documentSnapshotFileName = createReviewBatchDocumentSnapshotFileName({
    batchId,
    exportedAt: now,
    source
  });
  let contextPackRelativePath: string | undefined;
  let documentSnapshotRelativePath: string | undefined;

  try {
    documentSnapshotRelativePath = await writeProjectContextPack({
      contents: markdown,
      fileName: documentSnapshotFileName,
      project
    });
    const writtenDocumentSnapshot = await readProjectContextPack({
      project,
      relativePath: documentSnapshotRelativePath
    });
    const writtenDocumentSha256 = await createReviewBatchSha256(
      writtenDocumentSnapshot
    );
    if (
      writtenDocumentSnapshot !== markdown ||
      writtenDocumentSha256 !== documentContentSha256
    ) {
      throw new Error(
        "The written Review Batch document snapshot could not be verified."
      );
    }

    contextPackRelativePath = await writeProjectContextPack({
      contents: builtPrompt.promptText,
      fileName: contextPackFileName,
      project
    });
    const writtenPrompt = await readProjectContextPack({
      project,
      relativePath: contextPackRelativePath
    });
    const writtenPromptSha256 = await createReviewBatchSha256(writtenPrompt);
    if (
      writtenPrompt !== builtPrompt.promptText ||
      writtenPromptSha256 !== promptSha256
    ) {
      throw new Error(
        "The written Review Batch context pack could not be verified."
      );
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
      document_snapshot: {
        relative_path: documentSnapshotRelativePath,
        content_sha256: writtenDocumentSha256,
        bytes: new TextEncoder().encode(writtenDocumentSnapshot).byteLength
      },
      comment_fingerprints: commentFingerprints,
      estimated_prompt_tokens: estimatedPromptTokens,
      over_limit_warning:
        overLimitWarning ||
        estimatedPromptTokens > REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS,
      prompt_sha256: promptSha256,
      context_pack: {
        relative_path: contextPackRelativePath,
        content_sha256: writtenPromptSha256,
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
    await Promise.all(
      [contextPackRelativePath, documentSnapshotRelativePath]
        .filter((relativePath): relativePath is string => Boolean(relativePath))
        .map((relativePath) =>
          removeProjectContextPack({ project, relativePath }).catch(() => false)
        )
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

export async function readExactReviewBatchPromptBytes(input: {
  batch: PatchmarkReviewBatch;
  project: PatchmarkProjectHandle;
}): Promise<Uint8Array> {
  return new TextEncoder().encode(await readExactReviewBatchPrompt(input));
}

export class ReviewBatchDocumentSnapshotError extends Error {
  readonly code:
    | "exported_document_snapshot_invalid"
    | "exported_document_snapshot_unavailable";
  readonly repairPromptEligible = false;

  constructor(
    code: ReviewBatchDocumentSnapshotError["code"],
    message: string
  ) {
    super(message);
    this.name = "ReviewBatchDocumentSnapshotError";
    this.code = code;
  }
}

export async function readExactReviewBatchDocumentSnapshot({
  batch,
  currentMarkdown,
  project
}: {
  batch: PatchmarkReviewBatch;
  currentMarkdown?: string;
  project: PatchmarkProjectHandle;
}): Promise<{
  markdown: string;
  source: "persisted_snapshot" | "verified_current_document";
}> {
  const identity = getProjectDocumentIdentity(project);
  if (
    batch.project_id !== identity.projectId ||
    batch.document_id !== identity.documentId
  ) {
    throw new ReviewBatchDocumentSnapshotError(
      "exported_document_snapshot_invalid",
      "The Review Batch document snapshot belongs to another document."
    );
  }

  if (batch.document_snapshot) {
    let markdown: string;
    try {
      markdown = await readProjectContextPack({
        project,
        relativePath: batch.document_snapshot.relative_path
      });
    } catch {
      throw new ReviewBatchDocumentSnapshotError(
        "exported_document_snapshot_invalid",
        "The exact document snapshot exported with this Review Batch is missing."
      );
    }
    const bytes = new TextEncoder().encode(markdown).byteLength;
    const sha256 = await createReviewBatchSha256(markdown);
    if (
      bytes !== batch.document_snapshot.bytes ||
      sha256 !== batch.document_snapshot.content_sha256 ||
      sha256 !== batch.document_content_sha256
    ) {
      throw new ReviewBatchDocumentSnapshotError(
        "exported_document_snapshot_invalid",
        "The exact document snapshot exported with this Review Batch no longer matches its fingerprint."
      );
    }
    return {
      markdown,
      source: "persisted_snapshot"
    };
  }

  if (
    currentMarkdown !== undefined &&
    (await createReviewBatchSha256(currentMarkdown)) ===
      batch.document_content_sha256
  ) {
    return {
      markdown: currentMarkdown,
      source: "verified_current_document"
    };
  }

  throw new ReviewBatchDocumentSnapshotError(
    "exported_document_snapshot_unavailable",
    "This legacy Review Batch does not retain an exact exported document snapshot, and the current saved document no longer matches its fingerprint. The response was preserved for retry."
  );
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

function createReviewBatchDocumentSnapshotFileName({
  batchId,
  exportedAt,
  source
}: {
  batchId: string;
  exportedAt: string;
  source: ReviewBatchSource;
}): string {
  return createReviewBatchContextPackFileName({
    batchId,
    exportedAt,
    source
  }).replace(/-prompt\.md$/, "-document.md");
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

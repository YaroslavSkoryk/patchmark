import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createPatchReviewFoundationFixture(root) {
  const metadata = join(root, ".patchmark");
  const documentId = "doc_phase5_review";
  const projectId = "prj_phase5";
  const store = join(metadata, "documents", documentId);
  const now = "2026-08-10T00:00:00.000Z";
  const markdown = [
    "# Review Surface",
    "",
    "## Current workflow",
    "",
    "Queue hierarchy stays clear.",
    "",
    "Prerequisite source remains stable.",
    "",
    "Dependent source remains stable.",
    "",
    "## Applied history",
    "",
    "Applied replacement remains discussable.",
    "",
    "## Rejected history",
    "",
    "Rejected source remains unchanged.",
    "",
    "## Long content",
    "",
    "| State | Meaning | Action |",
    "| --- | --- | --- |",
    "| Pending | Awaiting a person | Inspect fully |"
  ].join("\n");
  const comments = [
    createComment({
      comment: "Simplify this review batch without weakening decisions.",
      id: "PM-COMMENT-0001",
      markdown,
      now,
      selectedText: "Queue hierarchy stays clear.",
      thread: [
        createThreadEntry("THREAD-1", "user", "Keep one canonical discussion."),
        createThreadEntry(
          "THREAD-2",
          "chatgpt",
          "The patch remains pending for explicit approval.",
          "PM-IMPORT-0001"
        )
      ]
    }),
    createComment({
      comment: "Keep this applied discussion available.",
      id: "PM-COMMENT-0002",
      markdown,
      now,
      selectedText: "Applied replacement remains discussable.",
      thread: [
        createThreadEntry(
          "THREAD-3",
          "user",
          "Continue this exact discussion after application."
        )
      ]
    }),
    createComment({
      comment: "Preserve rejected history.",
      id: "PM-COMMENT-0003",
      markdown,
      now,
      selectedText: "Rejected source remains unchanged."
    }),
    createComment({
      comment: "Coordinate dependency order.",
      id: "PM-COMMENT-0004",
      markdown,
      now,
      selectedText: "Prerequisite source remains stable."
    })
  ];
  const commonPatch = {
    suggested_text_sources: [],
    reason_sources: [],
    risk_sources: [],
    created_at: now
  };
  const patches = [
    {
      ...commonPatch,
      id: "PM-PATCH-0001",
      status: "pending",
      patch_group_id: "PM-PATCH-GROUP-0001",
      patch_group_index: 1,
      patch_group_total: 2,
      comment_id: "PM-COMMENT-0001",
      source_import_id: "PM-IMPORT-0001",
      source_patch_key: "compact-review",
      depends_on_patch_ids: [],
      depends_on_patch_keys_snapshot: [],
      display_title: "Clarify review hierarchy",
      target_heading: "## Current workflow",
      original_text: "Queue hierarchy stays clear.",
      suggested_text: [
        "Queue hierarchy stays clear with one focused inspector.",
        "",
        "| Surface | Persistent content |",
        "| --- | --- |",
        "| Queue | Identity and status |",
        "| Inspector | Full proposed change |",
        "",
        "```text",
        "Decision callbacks remain unchanged.",
        "```"
      ].join("\n"),
      reason:
        "Make the proposed change dominant while preserving exact Markdown, tables, and code-like content.",
      risk: "The queue must not obscure blockers or discussion state."
    },
    {
      ...commonPatch,
      id: "PM-PATCH-0002",
      status: "stale",
      patch_group_id: "PM-PATCH-GROUP-0001",
      patch_group_index: 2,
      patch_group_total: 2,
      comment_id: "PM-COMMENT-0001",
      source_import_id: "PM-IMPORT-0001",
      display_title: "Unavailable historical target",
      target_heading: "## Current workflow",
      original_text: "Removed unavailable target.",
      suggested_text: "Replacement that cannot be safely located.",
      reason: "Demonstrate unavailable target history."
    },
    {
      ...commonPatch,
      id: "PM-PATCH-0003",
      status: "pending",
      patch_group_id: "PM-PATCH-GROUP-0002",
      patch_group_index: 1,
      patch_group_total: 2,
      comment_id: "PM-COMMENT-0004",
      source_import_id: "PM-IMPORT-0001",
      source_patch_key: "prerequisite",
      depends_on_patch_ids: [],
      depends_on_patch_keys_snapshot: [],
      display_title: "Required prerequisite",
      target_heading: "## Current workflow",
      original_text: "Prerequisite source remains stable.",
      suggested_text: "Prerequisite source is applied first.",
      reason: "Establish the required document state."
    },
    {
      ...commonPatch,
      id: "PM-PATCH-0004",
      status: "pending",
      patch_group_id: "PM-PATCH-GROUP-0002",
      patch_group_index: 2,
      patch_group_total: 2,
      comment_id: "PM-COMMENT-0004",
      source_import_id: "PM-IMPORT-0001",
      source_patch_key: "dependent",
      depends_on_patch_ids: ["PM-PATCH-0003"],
      depends_on_patch_keys_snapshot: ["prerequisite"],
      display_title: "Blocked dependent patch",
      target_heading: "## Current workflow",
      original_text: "Dependent source remains stable.",
      suggested_text: "Dependent source changes only after its prerequisite.",
      reason: "Preserve dependency ordering."
    },
    {
      ...commonPatch,
      id: "PM-PATCH-0005",
      status: "accepted",
      patch_group_id: "PM-PATCH-GROUP-0003",
      patch_group_index: 1,
      patch_group_total: 1,
      comment_id: "PM-COMMENT-0002",
      source_import_id: "PM-IMPORT-0002",
      display_title: "Applied canonical discussion",
      target_heading: "## Applied history",
      original_text: "Applied source was replaced.",
      suggested_text: "Applied replacement remains discussable.",
      applied_text: "Applied replacement remains discussable.",
      applied_start_offset: markdown.indexOf(
        "Applied replacement remains discussable."
      ),
      applied_end_offset:
        markdown.indexOf("Applied replacement remains discussable.") +
        "Applied replacement remains discussable.".length,
      accepted_at: now,
      applied_at: now,
      resolved_at: now,
      reason: "Preserve discussion after application."
    },
    {
      ...commonPatch,
      id: "PM-PATCH-0006",
      status: "rejected",
      patch_group_id: "PM-PATCH-GROUP-0004",
      patch_group_index: 1,
      patch_group_total: 1,
      comment_id: "PM-COMMENT-0003",
      source_import_id: "PM-IMPORT-0002",
      display_title: "Rejected historical patch",
      target_heading: "## Rejected history",
      original_text: "Rejected source remains unchanged.",
      suggested_text: "Rejected replacement was not applied.",
      rejected_at: now,
      resolved_at: now,
      reason: "Preserve explicit rejection history."
    }
  ];
  const reviewBatches = [
    createReviewBatch({
      batchId: "review_batch_phase5_current",
      commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0004"],
      importId: "PM-IMPORT-0001",
      now,
      projectId,
      documentId,
      status: "acknowledged"
    }),
    createReviewBatch({
      batchId: "review_batch_phase5_history",
      commentIds: ["PM-COMMENT-0002", "PM-COMMENT-0003"],
      importId: "PM-IMPORT-0002",
      now: "2026-08-09T00:00:00.000Z",
      projectId,
      documentId,
      status: "acknowledged"
    }),
    createReviewBatch({
      batchId: "review_batch_phase5_cancelled",
      commentIds: ["PM-COMMENT-0003"],
      importId: null,
      now: "2026-08-08T00:00:00.000Z",
      projectId,
      documentId,
      status: "cancelled"
    })
  ];
  const manifest = {
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    project_name: "Phase 5 Evidence",
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    save_generation: 2,
    save_commit_id: "PM-SAVE-000002-PHASE5"
  };
  const commentsText = serialize(comments);
  const patchesText = serialize(patches);
  const reviewBatchesText = serialize(reviewBatches);
  const manifestText = serialize(manifest);

  for (const directory of ["versions", "context-packs", "imports", "recovery"]) {
    mkdirSync(join(store, directory), { recursive: true });
  }
  writeFileSync(join(root, "review.md"), markdown);
  writeFileSync(
    join(metadata, "project.json"),
    serialize({
      format: "patchmark-project",
      schema_version: 1,
      project_id: projectId,
      title: "Phase 5 Evidence",
      created_at: now,
      manifest_revision: 1,
      documents: [
        {
          document_id: documentId,
          path: "review.md",
          display_title: "Review Surface",
          role: "decision",
          status: "active",
          position: 1000,
          added_at: now,
          archived_at: null
        }
      ]
    })
  );
  writeFileSync(join(store, "manifest.json"), manifestText);
  writeFileSync(
    join(store, "document.json"),
    serialize({
      format: "patchmark-document-store",
      schema_version: 1,
      document_id: documentId,
      created_at: now,
      source: "created"
    })
  );
  writeFileSync(join(store, "comments.json"), commentsText);
  writeFileSync(join(store, "patches.json"), patchesText);
  writeFileSync(join(store, "review-batches.json"), reviewBatchesText);
  writeFileSync(join(store, "review-queue-overrides.json"), "{}\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
  for (const batch of reviewBatches) {
    writeFileSync(
      join(store, "context-packs", `${batch.batch_id}.md`),
      `Saved context for ${batch.batch_id}.\n`
    );
  }
  writeFileSync(
    join(store, "save-commit.json"),
    serialize({
      format_version: 1,
      generation: 2,
      commit_id: "PM-SAVE-000002-PHASE5",
      created_at: now,
      files: {
        document: createDescriptor("document.md", markdown),
        comments: createDescriptor(".patchmark/comments.json", commentsText),
        patches: createDescriptor(".patchmark/patches.json", patchesText),
        manifest: createDescriptor(".patchmark/manifest.json", manifestText),
        review_batches: createDescriptor(
          ".patchmark/review-batches.json",
          reviewBatchesText
        )
      }
    })
  );

  return {
    comments,
    documentId,
    markdown,
    patches,
    projectId,
    reviewBatches,
    store
  };
}

function createComment({
  comment,
  id,
  markdown,
  now,
  selectedText,
  thread = []
}) {
  const start = markdown.indexOf(selectedText);
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length,
      anchor_source: "markdown"
    },
    comment,
    thread,
    export_state: { focus_state: "idle" },
    created_at: now,
    updated_at: now
  };
}

function createThreadEntry(id, role, content, sourceImportId) {
  return {
    id,
    role,
    content,
    created_at: "2026-08-10T00:05:00.000Z",
    ...(sourceImportId ? { source_import_id: sourceImportId } : {})
  };
}

function createReviewBatch({
  batchId,
  commentIds,
  documentId,
  importId,
  now,
  projectId,
  status
}) {
  const cancelled = status === "cancelled";
  const promptText = `Saved context for ${batchId}.\n`;
  const promptHash = createHash("sha256").update(promptText).digest("hex");
  return {
    schema_version: 1,
    batch_id: batchId,
    project_id: projectId,
    document_id: documentId,
    source: "manual",
    batch_type: "manual",
    ordered_comment_ids: commentIds,
    section: null,
    algorithm_version: null,
    prompt_builder_version: 1,
    document_generation: 1,
    batch_record_generation: 2,
    document_content_sha256: "a".repeat(64),
    comment_fingerprints: commentIds.map((commentId) => ({
      comment_id: commentId,
      fingerprint: createHash("sha256").update(commentId).digest("hex")
    })),
    estimated_prompt_tokens: 100,
    over_limit_warning: false,
    prompt_sha256: promptHash,
    context_pack: {
      relative_path: `.patchmark/context-packs/${batchId}.md`,
      content_sha256: promptHash,
      bytes: Buffer.byteLength(promptText)
    },
    document_title_snapshot: "Review Surface",
    status,
    created_at: now,
    exported_at: now,
    response_received_at: cancelled ? null : now,
    acknowledged_at: cancelled ? null : now,
    cancelled_at: cancelled ? now : null,
    cancel_reason: cancelled ? "user_cancelled" : null,
    import_id: cancelled ? null : importId,
    response_analysis: null
  };
}

function createDescriptor(path, text) {
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text)
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

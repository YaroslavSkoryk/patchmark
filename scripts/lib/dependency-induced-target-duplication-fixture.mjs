import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET_DUPLICATION_RESPONSE_BYTES = 5_759;
export const TARGET_DUPLICATION_RESPONSE_SHA256 =
  "27df71fdeb69fbe9d67a7e75a9d093243978a766a499be1fcc9351418e1e8a6f";
export const TARGET_DUPLICATION_RESPONSE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "dependency-induced-target-duplication.json"
);

export function readTargetDuplicationResponseFixture() {
  const raw = readFileSync(TARGET_DUPLICATION_RESPONSE_PATH, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (
    Buffer.byteLength(raw) !== TARGET_DUPLICATION_RESPONSE_BYTES ||
    sha256 !== TARGET_DUPLICATION_RESPONSE_SHA256
  ) {
    throw new Error("The target-duplication response fixture bytes changed.");
  }
  return { parsed: JSON.parse(raw), raw };
}

export function createTargetDuplicationMarkdown(response) {
  const prerequisite = getProposal(response, "add-complete-sensitivity-appendix");
  const dependent = getProposal(response, "present-essential-sensitivity-indicators");
  return `# Strategy\n\n## 10. Growth Path and Scenarios\n\nPlanning basis.\n\n${dependent.original_text}\n\n### Stage gates informed by the scenarios\n\nStage-gate detail remains intact.\n\n${prerequisite.original_text}\n`;
}

export function createTargetDuplicationProjectFixture(root) {
  const { parsed: response, raw } = readTargetDuplicationResponseFixture();
  const now = "2026-08-06T00:00:00.000Z";
  const metadata = join(root, ".patchmark");
  const store = join(metadata, "documents", response.document_id);
  const markdown = createTargetDuplicationMarkdown(response);
  const documentPath = "strategy.md";
  const promptText = "Dependency-induced target duplication regression.";
  const comment = {
    id: "PM-COMMENT-0086",
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment: "Keep the main sensitivity view concise without losing detail.",
    thread: [],
    export_state: { focus_state: "awaiting_reply" },
    created_at: now,
    updated_at: now
  };
  const documentHash = createHash("sha256").update(markdown).digest("hex");
  const promptHash = createHash("sha256").update(promptText).digest("hex");
  const reviewBatch = {
    schema_version: 1,
    batch_id: response.review_batch_id,
    project_id: response.project_id,
    document_id: response.document_id,
    source: "manual",
    batch_type: "manual",
    ordered_comment_ids: [comment.id],
    section: null,
    algorithm_version: null,
    prompt_builder_version: 1,
    document_generation: 1,
    batch_record_generation: 2,
    document_content_sha256: documentHash,
    comment_fingerprints: [
      {
        comment_id: comment.id,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(comment))
          .digest("hex")
      }
    ],
    estimated_prompt_tokens: 10,
    over_limit_warning: false,
    prompt_sha256: promptHash,
    context_pack: {
      relative_path: ".patchmark/context-packs/target-duplication.md",
      content_sha256: promptHash,
      bytes: Buffer.byteLength(promptText)
    },
    document_title_snapshot: "Strategy",
    status: "exported",
    created_at: now,
    exported_at: now,
    response_received_at: null,
    cancelled_at: null,
    cancel_reason: null,
    import_id: null
  };
  const commitId = "PM-SAVE-000001-TARGET-DUPLICATION";
  const manifest = {
    schema_version: 1,
    project_id: response.project_id,
    document_id: response.document_id,
    project_name: "Strategy Target Duplication",
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    save_generation: 2,
    save_commit_id: commitId
  };
  const commentsText = serializeJson([comment]);
  const patchesText = serializeJson([]);
  const manifestText = serializeJson(manifest);
  const reviewBatchesText = serializeJson([reviewBatch]);

  mkdirSync(join(store, "versions"), { recursive: true });
  mkdirSync(join(store, "context-packs"), { recursive: true });
  mkdirSync(join(store, "imports"), { recursive: true });
  mkdirSync(join(store, "recovery"), { recursive: true });
  writeFileSync(join(root, documentPath), markdown);
  writeJson(join(metadata, "project.json"), {
    format: "patchmark-project",
    schema_version: 1,
    project_id: response.project_id,
    title: "Strategy Target Duplication",
    created_at: now,
    manifest_revision: 1,
    documents: [
      {
        document_id: response.document_id,
        path: documentPath,
        display_title: "Strategy",
        role: "decision",
        status: "active",
        position: 1000,
        added_at: now,
        archived_at: null
      }
    ]
  });
  writeFileSync(join(store, "manifest.json"), manifestText);
  writeFileSync(join(store, "comments.json"), commentsText);
  writeFileSync(join(store, "patches.json"), patchesText);
  writeJson(join(store, "tasks.json"), []);
  writeJson(join(store, "document.json"), {
    format: "patchmark-document-store",
    schema_version: 1,
    document_id: response.document_id,
    created_at: now,
    source: "created"
  });
  writeFileSync(
    join(store, "context-packs", "target-duplication.md"),
    promptText
  );
  writeFileSync(join(store, "review-batches.json"), reviewBatchesText);
  writeJson(join(store, "save-commit.json"), {
    format_version: 1,
    generation: 2,
    commit_id: commitId,
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
  });

  return { comment, markdown, raw, response, reviewBatch, store };
}

function getProposal(response, patchKey) {
  const proposal = response.patch_proposals.find(
    (candidate) => candidate.patch_key === patchKey
  );
  if (!proposal) {
    throw new Error(`Missing target-duplication patch ${patchKey}.`);
  }
  return proposal;
}

function writeJson(path, value) {
  writeFileSync(path, serializeJson(value));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createDescriptor(path, text) {
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text)
  };
}

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ATOMIC_MULTI_TABLE_RESPONSE_BYTES = 29_696;
export const ATOMIC_MULTI_TABLE_RESPONSE_SHA256 =
  "8e4c545f081443489f86551c30ff43f293f20f20ebc4f424adb0b7c4ad4b284d";
export const ATOMIC_MULTI_TABLE_RESPONSE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "atomic-multi-table-import-response.json"
);

export function readAtomicMultiTableResponseFixture() {
  const stored = readFileSync(ATOMIC_MULTI_TABLE_RESPONSE_PATH, "utf8");
  const raw = stored.endsWith("\n") ? stored.slice(0, -1) : stored;

  if (
    Buffer.byteLength(raw) !== ATOMIC_MULTI_TABLE_RESPONSE_BYTES ||
    sha256(raw) !== ATOMIC_MULTI_TABLE_RESPONSE_SHA256
  ) {
    throw new Error("The exact atomic multi-table response fixture bytes changed.");
  }

  return {
    parsed: JSON.parse(raw),
    raw
  };
}

export function createAtomicMultiTableMarkdown(response) {
  const proposal = response.patch_proposals[0];

  if (!proposal) {
    throw new Error("The atomic multi-table fixture proposal is missing.");
  }

  return [
    "# Growth strategy",
    "",
    proposal.target_heading,
    "",
    proposal.original_text,
    "",
    "## 11. Operations",
    "",
    "The next section remains unchanged."
  ].join("\n");
}

export function createAtomicMultiTableComment(response, markdown) {
  const proposal = response.patch_proposals[0];
  const heading = proposal.target_heading.replace(/^#{1,6}\s+/, "");
  const now = "2026-07-31T12:29:20.000Z";

  return {
    id: proposal.comment_id,
    type: "note",
    status: "open",
    anchor: {
      kind: "section",
      heading,
      heading_level: 2,
      heading_line: markdown.slice(0, markdown.indexOf(proposal.target_heading)).split("\n")
        .length,
      heading_path: ["Growth strategy", heading]
    },
    comment: "Restructure the planning tables and stage gates as one atomic region.",
    thread: [],
    export_state: { focus_state: "awaiting_reply" },
    created_at: now,
    updated_at: now
  };
}

export function createAtomicMultiTableProjectFixture(root) {
  const { parsed: response, raw } = readAtomicMultiTableResponseFixture();
  const markdown = createAtomicMultiTableMarkdown(response);
  const comment = createAtomicMultiTableComment(response, markdown);
  const now = "2026-07-31T12:29:20.000Z";
  const metadata = join(root, ".patchmark");
  const store = join(metadata, "documents", response.document_id);
  const documentPath = "growth-strategy.md";
  const promptText = "Exact atomic multi-table import regression.";
  const promptHash = sha256(promptText);
  const reviewBatch = {
    schema_version: 1,
    batch_id: response.review_batch_id,
    project_id: response.project_id,
    document_id: response.document_id,
    source: "guided_review",
    batch_type: "section",
    ordered_comment_ids: [comment.id],
    section: {
      section_key_snapshot: "heading:10-growth-path-and-scenarios",
      heading_snapshot: "10. Growth Path and Scenarios"
    },
    algorithm_version: 1,
    prompt_builder_version: 1,
    document_generation: 7,
    batch_record_generation: 8,
    document_content_sha256: sha256(markdown),
    document_snapshot: {
      relative_path: ".patchmark/context-packs/atomic-exported-document.md",
      content_sha256: sha256(markdown),
      bytes: Buffer.byteLength(markdown)
    },
    comment_fingerprints: [
      {
        comment_id: comment.id,
        fingerprint: sha256(JSON.stringify(comment))
      }
    ],
    estimated_prompt_tokens: 10,
    over_limit_warning: false,
    prompt_sha256: promptHash,
    context_pack: {
      relative_path: ".patchmark/context-packs/atomic-response.md",
      content_sha256: promptHash,
      bytes: Buffer.byteLength(promptText)
    },
    document_title_snapshot: "Growth strategy",
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
  const commitId = "PM-SAVE-000008-ATOMIC-MULTI-TABLE";
  const manifest = {
    schema_version: 1,
    project_id: response.project_id,
    document_id: response.document_id,
    project_name: "Atomic Multi Table",
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    save_generation: 8,
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
    title: "Atomic Multi Table",
    created_at: now,
    manifest_revision: 1,
    documents: [
      {
        document_id: response.document_id,
        path: documentPath,
        display_title: "Growth strategy",
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
  writeFileSync(join(store, "context-packs", "atomic-response.md"), promptText);
  writeFileSync(
    join(store, "context-packs", "atomic-exported-document.md"),
    markdown
  );
  writeFileSync(join(store, "review-batches.json"), reviewBatchesText);
  writeJson(join(store, "save-commit.json"), {
    format_version: 1,
    generation: 8,
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

  return {
    comment,
    markdown,
    raw,
    response,
    reviewBatch,
    store
  };
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
    sha256: sha256(text),
    bytes: Buffer.byteLength(text)
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

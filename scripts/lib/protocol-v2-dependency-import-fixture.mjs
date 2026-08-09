import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXACT_PROTOCOL_V2_RESPONSE_BYTES = 48_628;
export const EXACT_PROTOCOL_V2_RESPONSE_SHA256 =
  "b6bd216374911644cc49c7045d92ad66217617e9eb45317e4421f25dcf9df7ff";
export const EXACT_PROTOCOL_V2_RESPONSE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "protocol-v2-dependency-import-response.json"
);

const COMPETITOR_PATCH_KEYS = [
  "link-horme-evidence",
  "link-routine-evidence",
  "link-merak-evidence",
  "link-kaarom-evidence",
  "link-fix-evidence",
  "link-crumbs-evidence",
  "link-nana-evidence",
  "link-casa-lapin-evidence"
];
const ANALOGUE_PATCH_KEYS = [
  "link-holey-delivery-review",
  "link-sandwich-format-analogue"
];

export function readExactProtocolV2ResponseFixture() {
  const raw = readFileSync(EXACT_PROTOCOL_V2_RESPONSE_PATH, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");

  if (
    Buffer.byteLength(raw) !== EXACT_PROTOCOL_V2_RESPONSE_BYTES ||
    sha256 !== EXACT_PROTOCOL_V2_RESPONSE_SHA256
  ) {
    throw new Error("The exact protocol-v2 response fixture bytes changed.");
  }

  return {
    parsed: JSON.parse(raw),
    raw
  };
}

export function createExactProtocolV2Markdown(response) {
  const proposalsByKey = new Map(
    response.patch_proposals.map((proposal) => [
      proposal.patch_key,
      proposal
    ])
  );
  const originalText = (patchKey) => {
    const proposal = proposalsByKey.get(patchKey);

    if (!proposal) {
      throw new Error(`Missing exact fixture patch ${patchKey}.`);
    }

    return proposal.original_text;
  };

  return [
    "# Strategy",
    "",
    "## 2. Strategic context",
    "",
    originalText("identify-internal-strategy-source"),
    "",
    "### 4.1 What the available evidence supports",
    "",
    originalText("link-historical-category-signal"),
    "",
    "### 4.2 Observed price and product bands",
    "",
    originalText("link-observed-menu-prices"),
    "",
    originalText("competitor-observation-dates") +
      " | Evidence | Offer and price snapshot | Public rating context | Model | What it shows | Caveat |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...COMPETITOR_PATCH_KEYS.map(originalText),
    "",
    originalText("analogue-observation-dates") +
      " | Evidence | Implication | Caveat |",
    "| --- | --- | --- | --- |",
    ...ANALOGUE_PATCH_KEYS.map(originalText),
    "",
    "### Stage 4 — Platform test",
    "",
    originalText("link-grab-merchant-context"),
    "",
    originalText("link-foodpanda-exit-evidence"),
    "",
    originalText("remove-redundant-sources-section")
  ].join("\n");
}

export function createExactProtocolV2ProjectFixture(root) {
  const { parsed: response, raw } = readExactProtocolV2ResponseFixture();
  const now = "2026-07-24T00:00:00.000Z";
  const metadata = join(root, ".patchmark");
  const store = join(metadata, "documents", response.document_id);
  const markdown = createExactProtocolV2Markdown(response);
  const documentPath = "strategy.md";
  const promptText = "Exact protocol-v2 dependency import regression.";
  const selectedText = response.patch_proposals.find(
    (proposal) =>
      proposal.patch_key === "remove-redundant-sources-section"
  )?.original_text;

  if (!selectedText) {
    throw new Error("The exact response lacks its source-deletion patch.");
  }

  const selectedStart = markdown.indexOf(selectedText);
  const comment = {
    id: "PM-COMMENT-0019",
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: selectedStart,
      markdown_end_offset: selectedStart + selectedText.length,
      context_before: markdown.slice(
        Math.max(0, selectedStart - 80),
        selectedStart
      ),
      context_after: markdown.slice(
        selectedStart + selectedText.length,
        selectedStart + selectedText.length + 80
      ),
      anchor_source: "markdown"
    },
    comment: "Move source information inline.",
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
    document_generation: 12,
    batch_record_generation: 13,
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
      relative_path: ".patchmark/context-packs/exact-response.md",
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
  const commitId = "PM-SAVE-000013-EXACT-PROTOCOL-V2";
  const manifest = {
    schema_version: 1,
    project_id: response.project_id,
    document_id: response.document_id,
    project_name: "Strategy Exact Protocol V2",
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    save_generation: 13,
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
  writeJson(
    join(metadata, "project.json"),
    {
      format: "patchmark-project",
      schema_version: 1,
      project_id: response.project_id,
      title: "Strategy Exact Protocol V2",
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
    }
  );
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
  writeFileSync(join(store, "context-packs", "exact-response.md"), promptText);
  writeFileSync(join(store, "review-batches.json"), reviewBatchesText);
  writeJson(join(store, "save-commit.json"), {
    format_version: 1,
    generation: 13,
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
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text)
  };
}

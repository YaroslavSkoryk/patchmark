import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INDEPENDENT_PROTOCOL_V2_RESPONSE_BYTES = 11_573;
export const INDEPENDENT_PROTOCOL_V2_RESPONSE_SHA256 =
  "08b1eba33fae1244d101c6d4d3b2a1fe4b1df7d77a43847a448d8ba56e0d3ffa";
export const INDEPENDENT_PROTOCOL_V2_RESPONSE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "independent-protocol-v2-import-response.json"
);

export function readIndependentProtocolV2ResponseFixture() {
  const stored = readFileSync(
    INDEPENDENT_PROTOCOL_V2_RESPONSE_PATH,
    "utf8"
  );
  const raw = stored.endsWith("\n") ? stored.slice(0, -1) : stored;
  const sha256 = createHash("sha256").update(raw).digest("hex");

  if (
    Buffer.byteLength(raw) !== INDEPENDENT_PROTOCOL_V2_RESPONSE_BYTES ||
    sha256 !== INDEPENDENT_PROTOCOL_V2_RESPONSE_SHA256
  ) {
    throw new Error(
      "The exact independent protocol-v2 response fixture bytes changed."
    );
  }

  return {
    parsed: JSON.parse(raw),
    raw
  };
}

export function createIndependentProtocolV2Markdown(response) {
  const proposalsByKey = new Map(
    response.patch_proposals.map((proposal) => [
      proposal.patch_key,
      proposal
    ])
  );
  const originalText = (patchKey) => {
    const proposal = proposalsByKey.get(patchKey);

    if (!proposal) {
      throw new Error(`Missing independent fixture patch ${patchKey}.`);
    }

    return proposal.original_text;
  };

  return [
    "# Unit economics",
    "",
    "### 9.1 Required definitions",
    "",
    originalText("clarify-additional-utility-cost"),
    originalText("clarify-crust-chant-funded-promotions"),
    "",
    originalText("explain-unit-economics-formulas"),
    originalText("use-wholesale-bread-transfer-price")
  ].join("\n");
}

export function createIndependentProtocolV2Comments(response, markdown) {
  const now = "2026-07-24T00:00:00.000Z";

  return response.patch_proposals.map((proposal) => {
    const start = markdown.indexOf(proposal.original_text);

    if (start < 0) {
      throw new Error(
        `Missing comment anchor target for ${proposal.patch_key}.`
      );
    }

    return {
      id: proposal.comment_id,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: proposal.original_text,
        markdown_start_offset: start,
        markdown_end_offset: start + proposal.original_text.length,
        context_before: markdown.slice(Math.max(0, start - 80), start),
        context_after: markdown.slice(
          start + proposal.original_text.length,
          start + proposal.original_text.length + 80
        ),
        anchor_source: "markdown"
      },
      comment: `Review ${proposal.patch_key}.`,
      thread: [],
      export_state: { focus_state: "awaiting_reply" },
      created_at: now,
      updated_at: now
    };
  });
}

export function createIndependentProtocolV2ImportedPatches(response) {
  const idByKey = new Map(
    response.patch_proposals.map((proposal, index) => [
      proposal.patch_key,
      `PM-PATCH-${String(index + 1).padStart(4, "0")}`
    ])
  );

  return response.patch_proposals.map((proposal, index) => ({
    id: `PM-PATCH-${String(index + 1).padStart(4, "0")}`,
    status: "pending",
    patch_group_id: `PM-PATCH-GROUP-${String(index + 1).padStart(4, "0")}`,
    patch_group_index: 1,
    patch_group_total: 1,
    comment_id: proposal.comment_id,
    source_import_id: "PM-IMPORT-INDEPENDENT-EXACT",
    source_patch_key: proposal.patch_key,
    depends_on_patch_ids: proposal.depends_on.map((patchKey) =>
      idByKey.get(patchKey)
    ),
    depends_on_patch_keys_snapshot: [...proposal.depends_on],
    display_title: proposal.display_title,
    target_heading: proposal.target_heading,
    original_text: proposal.original_text,
    suggested_text: proposal.suggested_text,
    suggested_text_sources: proposal.suggested_text_sources,
    reason: proposal.reason,
    reason_sources: proposal.reason_sources,
    risk: proposal.risk,
    risk_sources: proposal.risk_sources,
    created_at: "2026-07-24T00:00:00.000Z"
  }));
}

export function createIndependentProtocolV2ProjectFixture(
  root,
  { staleFormula = false } = {}
) {
  const { parsed: response, raw } =
    readIndependentProtocolV2ResponseFixture();
  const now = "2026-07-24T00:00:00.000Z";
  const metadata = join(root, ".patchmark");
  const store = join(metadata, "documents", response.document_id);
  const exportedMarkdown = createIndependentProtocolV2Markdown(response);
  const markdown = staleFormula
    ? exportedMarkdown.replace(
        "Let:\n\n* `R`",
        "Use these definitions:\n\n* `R`"
      )
    : exportedMarkdown;
  const comments = createIndependentProtocolV2Comments(
    response,
    exportedMarkdown
  );
  const documentPath = "unit-economics.md";
  const promptText = "Exact independent protocol-v2 import regression.";
  const promptHash = sha256(promptText);
  const reviewBatch = {
    schema_version: 1,
    batch_id: response.review_batch_id,
    project_id: response.project_id,
    document_id: response.document_id,
    source: "manual",
    batch_type: "manual",
    ordered_comment_ids: comments.map((comment) => comment.id),
    section: null,
    algorithm_version: null,
    prompt_builder_version: 1,
    document_generation: 12,
    batch_record_generation: 13,
    document_content_sha256: sha256(exportedMarkdown),
    comment_fingerprints: comments.map((comment) => ({
      comment_id: comment.id,
      fingerprint: sha256(JSON.stringify(comment))
    })),
    estimated_prompt_tokens: 10,
    over_limit_warning: false,
    prompt_sha256: promptHash,
    context_pack: {
      relative_path: ".patchmark/context-packs/independent-response.md",
      content_sha256: promptHash,
      bytes: Buffer.byteLength(promptText)
    },
    document_title_snapshot: "Unit economics",
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
  const commitId = "PM-SAVE-000013-INDEPENDENT-PROTOCOL-V2";
  const manifest = {
    schema_version: 1,
    project_id: response.project_id,
    document_id: response.document_id,
    project_name: "Independent Protocol V2",
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    save_generation: 13,
    save_commit_id: commitId
  };
  const commentsText = serializeJson(comments);
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
      title: "Independent Protocol V2",
      created_at: now,
      manifest_revision: 1,
      documents: [
        {
          document_id: response.document_id,
          path: documentPath,
          display_title: "Unit economics",
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
  writeFileSync(
    join(store, "context-packs", "independent-response.md"),
    promptText
  );
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
    comments,
    exportedMarkdown,
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

import {
  COLLABORATION_SHADOW_RECEIPT_VERSION,
  collaborationShadowMutationKinds,
  type CollaborationShadowMutationReceipt,
  type ShadowLegacyCommitReceipt,
  type ShadowLegacyDocumentContent,
  type ShadowLegacySharedState
} from "./contracts.ts";
import {
  expectArray,
  expectBoolean,
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectNonEmptyString,
  expectString,
  freezeRecord,
  parseUniqueArray
} from "../collaboration/validation.ts";

export function parseCollaborationShadowMutationReceipt(
  value: unknown
): CollaborationShadowMutationReceipt {
  const record = expectExactRecord(value, "collaboration shadow mutation receipt", [
    "schema_version",
    "object_kind",
    "source_project_instance_commitment",
    "source_project_id",
    "source_document_id",
    "mutation_kind",
    "mutation_key",
    "legacy_commit",
    "committed_shared_state"
  ]);
  expectLiteral(
    record.schema_version,
    COLLABORATION_SHADOW_RECEIPT_VERSION,
    "shadow receipt schema version"
  );
  expectLiteral(
    record.object_kind,
    "collaboration_shadow_mutation_receipt",
    "shadow receipt kind"
  );
  return freezeRecord({
    schema_version: COLLABORATION_SHADOW_RECEIPT_VERSION,
    object_kind: "collaboration_shadow_mutation_receipt" as const,
    source_project_instance_commitment: expectNonEmptyString(
      record.source_project_instance_commitment,
      "source project instance commitment"
    ),
    source_project_id: expectNonEmptyString(record.source_project_id, "source project ID"),
    source_document_id: expectNonEmptyString(record.source_document_id, "source document ID"),
    mutation_kind: expectEnum(
      record.mutation_kind,
      collaborationShadowMutationKinds,
      "shadow mutation kind"
    ),
    mutation_key: expectNonEmptyString(record.mutation_key, "shadow mutation key"),
    legacy_commit: parseLegacyCommit(record.legacy_commit),
    committed_shared_state: parseLegacySharedState(record.committed_shared_state)
  });
}

export function parseLegacySharedState(value: unknown): ShadowLegacySharedState {
  const record = expectExactRecord(value, "normalized legacy shared state", [
    "project_title",
    "group_order",
    "groups",
    "document_order",
    "documents"
  ]);
  const groups = parseUniqueArray(
    record.groups,
    "normalized legacy groups",
    (candidate) => {
      const group = expectExactRecord(candidate, "normalized legacy group", [
        "source_group_id",
        "title",
        "position"
      ]);
      return freezeRecord({
        source_group_id: expectNonEmptyString(group.source_group_id, "source group ID"),
        title: expectString(group.title, "source group title"),
        position: expectString(group.position, "source group position")
      });
    },
    (group) => group.source_group_id,
    { allowEmpty: true, requireSorted: true }
  );
  const documents = parseUniqueArray(
    record.documents,
    "normalized legacy documents",
    (candidate) => {
      const document = expectExactRecord(candidate, "normalized legacy document", [
        "source_document_id",
        "title",
        "logical_path",
        "position",
        "source_group_id",
        "archive_status",
        "tombstone",
        "content"
      ]);
      return freezeRecord({
        source_document_id: expectNonEmptyString(
          document.source_document_id,
          "source document ID"
        ),
        title: expectString(document.title, "source document title"),
        logical_path: expectString(document.logical_path, "source document path"),
        position: expectString(document.position, "source document position"),
        source_group_id: document.source_group_id === null
          ? null
          : expectNonEmptyString(document.source_group_id, "source document group ID"),
        archive_status: expectEnum(
          document.archive_status,
          ["active", "archived"] as const,
          "source document archive status"
        ),
        tombstone: expectBoolean(document.tombstone, "source document tombstone"),
        content: document.content === null ? null : parseDocumentContent(document.content)
      });
    },
    (document) => document.source_document_id,
    { allowEmpty: true, requireSorted: true }
  );
  const groupOrder = parseStringArray(record.group_order, "source group order");
  const documentOrder = parseStringArray(record.document_order, "source document order");
  requireExactSet(groupOrder, groups.map((group) => group.source_group_id), "source group order");
  requireExactSet(
    documentOrder,
    documents.filter((document) => !document.tombstone).map((document) => document.source_document_id),
    "source document order"
  );
  const groupIds = new Set(groups.map((group) => group.source_group_id));
  for (const document of documents) {
    if (document.source_group_id !== null && !groupIds.has(document.source_group_id)) {
      throw new Error("Normalized legacy document names an unknown source group.");
    }
  }
  return freezeRecord({
    project_title: expectString(record.project_title, "source project title"),
    group_order: groupOrder,
    groups,
    document_order: documentOrder,
    documents
  });
}

function parseDocumentContent(value: unknown): ShadowLegacyDocumentContent {
  const record = expectExactRecord(value, "normalized legacy document content", [
    "exact_markdown_bytes",
    "comments",
    "patches",
    "review_batches",
    "rewrite_sessions"
  ]);
  const comments = parseUniqueArray(
    record.comments,
    "normalized legacy comments",
    (candidate) => {
      const comment = expectExactRecord(candidate, "normalized legacy comment", [
        "source_comment_id",
        "body",
        "anchor",
        "status",
        "trash_status",
        "tombstone",
        "replies"
      ]);
      const anchor = expectExactRecord(comment.anchor, "normalized legacy anchor", [
        "kind",
        "key"
      ]);
      const kind = expectEnum(
        anchor.kind,
        ["document", "section", "selected_text"] as const,
        "legacy anchor kind"
      );
      const key = expectNonEmptyString(anchor.key, "legacy anchor key");
      if (kind === "document" && key !== "document") {
        throw new Error("A normalized document anchor must use the document key.");
      }
      const replies = parseUniqueArray(
        comment.replies,
        "normalized legacy replies",
        (replyValue) => {
          const reply = expectExactRecord(replyValue, "normalized legacy reply", [
            "source_reply_id",
            "body",
            "tombstone"
          ]);
          return freezeRecord({
            source_reply_id: expectNonEmptyString(reply.source_reply_id, "source reply ID"),
            body: expectString(reply.body, "source reply body"),
            tombstone: expectBoolean(reply.tombstone, "source reply tombstone")
          });
        },
        (reply) => reply.source_reply_id,
        { allowEmpty: true, requireSorted: true }
      );
      return freezeRecord({
        source_comment_id: expectNonEmptyString(comment.source_comment_id, "source comment ID"),
        body: expectString(comment.body, "source comment body"),
        anchor: freezeRecord({ kind, key }),
        status: expectEnum(comment.status, ["open", "resolved"] as const, "source comment status"),
        trash_status: expectEnum(
          comment.trash_status,
          ["active", "trashed"] as const,
          "source comment trash status"
        ),
        tombstone: expectBoolean(comment.tombstone, "source comment tombstone"),
        replies
      });
    },
    (comment) => comment.source_comment_id,
    { allowEmpty: true, requireSorted: true }
  );
  const patches = parseUniqueArray(
    record.patches,
    "normalized legacy patches",
    (candidate) => {
      const patch = expectExactRecord(candidate, "normalized legacy patch", [
        "source_patch_id",
        "source_comment_id",
        "version_fingerprint",
        "dependency_source_patch_ids",
        "target_provenance",
        "status"
      ]);
      return freezeRecord({
        source_patch_id: expectNonEmptyString(patch.source_patch_id, "source patch ID"),
        source_comment_id: patch.source_comment_id === null
          ? null
          : expectNonEmptyString(patch.source_comment_id, "source patch comment ID"),
        version_fingerprint: expectString(patch.version_fingerprint, "source patch fingerprint"),
        dependency_source_patch_ids: parseStringArray(
          patch.dependency_source_patch_ids,
          "source patch dependencies",
          true
        ),
        target_provenance: patch.target_provenance === null
          ? null
          : expectString(patch.target_provenance, "source patch target provenance"),
        status: expectEnum(
          patch.status,
          ["pending", "accepted", "rejected", "stale"] as const,
          "source patch status"
        )
      });
    },
    (patch) => patch.source_patch_id,
    { allowEmpty: true, requireSorted: true }
  );
  const reviewBatches = parseUniqueArray(
    record.review_batches,
    "normalized legacy review batches",
    (candidate) => {
      const batch = expectExactRecord(candidate, "normalized legacy review batch", [
        "source_review_batch_id",
        "lifecycle",
        "response_hash"
      ]);
      const responseHash = batch.response_hash === null
        ? null
        : expectString(batch.response_hash, "source review response hash");
      if (responseHash !== null && !/^[0-9a-f]{64}$/.test(responseHash)) {
        throw new Error("Source review response hash must be lowercase SHA-256.");
      }
      return freezeRecord({
        source_review_batch_id: expectNonEmptyString(
          batch.source_review_batch_id,
          "source review batch ID"
        ),
        lifecycle: expectEnum(
          batch.lifecycle,
          ["active", "responded", "cancelled"] as const,
          "source review lifecycle"
        ),
        response_hash: responseHash
      });
    },
    (batch) => batch.source_review_batch_id,
    { allowEmpty: true, requireSorted: true }
  );
  const rewrites = parseUniqueArray(
    record.rewrite_sessions,
    "normalized legacy rewrite sessions",
    (candidate) => {
      const rewrite = expectExactRecord(candidate, "normalized legacy rewrite", [
        "source_rewrite_session_id",
        "outcome"
      ]);
      return freezeRecord({
        source_rewrite_session_id: expectNonEmptyString(
          rewrite.source_rewrite_session_id,
          "source rewrite session ID"
        ),
        outcome: expectEnum(
          rewrite.outcome,
          ["active", "applied", "discarded"] as const,
          "source rewrite outcome"
        )
      });
    },
    (rewrite) => rewrite.source_rewrite_session_id,
    { allowEmpty: true, requireSorted: true }
  );
  return freezeRecord({
    exact_markdown_bytes: expectBytes(record.exact_markdown_bytes, "exact source Markdown bytes"),
    comments,
    patches,
    review_batches: reviewBatches,
    rewrite_sessions: rewrites
  });
}

function parseLegacyCommit(value: unknown): ShadowLegacyCommitReceipt {
  const discriminator = expectExactRecord(
    value,
    "legacy mutation commit receipt",
    ["commit_kind", "status", "source_state_commitment"],
    ["generation", "commit_id", "changed_files", "manifest_revision"]
  );
  expectLiteral(discriminator.status, "committed", "legacy mutation status");
  const kind = expectEnum(
    discriminator.commit_kind,
    ["project_save", "project_registry"] as const,
    "legacy commit kind"
  );
  const sourceCommitment = expectNonEmptyString(
    discriminator.source_state_commitment,
    "legacy source state commitment"
  );
  if (kind === "project_save") {
    const exact = expectExactRecord(value, "project save receipt", [
      "commit_kind",
      "status",
      "generation",
      "commit_id",
      "changed_files",
      "source_state_commitment"
    ]);
    const generation = expectSafeInteger(exact.generation, "legacy save generation");
    return freezeRecord({
      commit_kind: "project_save" as const,
      status: "committed" as const,
      generation,
      commit_id: expectNonEmptyString(exact.commit_id, "legacy save commit ID"),
      changed_files: parseStringArray(exact.changed_files, "legacy changed files", true),
      source_state_commitment: sourceCommitment
    });
  }
  const exact = expectExactRecord(value, "project registry receipt", [
    "commit_kind",
    "status",
    "manifest_revision",
    "source_state_commitment"
  ]);
  return freezeRecord({
    commit_kind: "project_registry" as const,
    status: "committed" as const,
    manifest_revision: expectSafeInteger(exact.manifest_revision, "registry manifest revision"),
    source_state_commitment: sourceCommitment
  });
}

function parseStringArray(
  value: unknown,
  label: string,
  requireSorted = false
): readonly string[] {
  const parsed = expectArray(value, label).map((entry) => expectNonEmptyString(entry, label));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} must be unique.`);
  if (requireSorted) {
    for (let index = 1; index < parsed.length; index += 1) {
      if (parsed[index - 1] >= parsed[index]) throw new Error(`${label} must be strictly sorted.`);
    }
  }
  return Object.freeze(parsed);
}

function requireExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if (
    actual.length !== expected.length ||
    actual.some((entry) => !expected.includes(entry))
  ) {
    throw new Error(`${label} must cover its normalized entities exactly once.`);
  }
}

function expectSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

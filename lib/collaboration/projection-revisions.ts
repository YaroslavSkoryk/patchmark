import {
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity
} from "./preimages.ts";
import type {
  DocumentId,
  DocumentRevisionId,
  MarkdownBlobId,
  ProjectId
} from "./identities.ts";
import type { DocumentRevisionRecord, MarkdownBlobDescription } from "./content.ts";
import type { CollaborationReadResult } from "./storage.ts";
import { CollaborationProjectionError } from "./projection-types.ts";

export type RevisionReadBoundary = Readonly<{
  project_id: ProjectId;
  read_revision: (
    revisionId: DocumentRevisionId
  ) => Promise<CollaborationReadResult<DocumentRevisionRecord>>;
  read_blob: (
    projectId: ProjectId,
    blobId: MarkdownBlobId
  ) => Promise<CollaborationReadResult<MarkdownBlobDescription>>;
}>;

export type VerifiedRevision = Readonly<{
  record: DocumentRevisionRecord;
  markdown_bytes: Uint8Array;
}>;

export type VerifiedRevisionGraph = Readonly<{
  revisions: readonly VerifiedRevision[];
}>;

export async function loadVerifiedRevisionGraph(
  boundary: RevisionReadBoundary,
  rootRevisionIds: readonly DocumentRevisionId[],
  expectedDocumentId?: DocumentId
): Promise<VerifiedRevisionGraph> {
  const loaded = new Map<DocumentRevisionId, VerifiedRevision>();
  const visiting = new Set<DocumentRevisionId>();
  const load = async (
    revisionId: DocumentRevisionId,
    expectedDocument: DocumentId | undefined
  ): Promise<void> => {
    const existing = loaded.get(revisionId);
    if (existing) {
      if (
        expectedDocument !== undefined &&
        existing.record.core.document_id !== expectedDocument
      ) {
        throw new CollaborationProjectionError(
          "cross_project_dependency",
          "A revision belongs to the wrong document.",
          revisionId
        );
      }
      return;
    }
    if (visiting.has(revisionId)) {
      throw new CollaborationProjectionError(
        "revision_closure_invalid",
        "Revision ancestry contains a cycle.",
        revisionId
      );
    }
    visiting.add(revisionId);
    const result = await boundary.read_revision(revisionId);
    if (result.status !== "valid") {
      throw revisionReadError(revisionId, result.status, result.reason);
    }
    const record = result.value;
    const identity = await deriveDocumentRevisionIdentity(record.core);
    if (record.revision_id !== revisionId || identity.id !== revisionId) {
      throw new CollaborationProjectionError(
        "corrupted_dependency",
        "A revision record does not match its digest identity.",
        revisionId
      );
    }
    if (
      record.core.project_id !== boundary.project_id ||
      (expectedDocument !== undefined &&
        record.core.document_id !== expectedDocument)
    ) {
      throw new CollaborationProjectionError(
        "cross_project_dependency",
        "A revision belongs to the wrong project or document.",
        revisionId
      );
    }
    const blobResult = await boundary.read_blob(
      boundary.project_id,
      record.core.markdown_blob_id
    );
    if (blobResult.status !== "valid") {
      throw blobReadError(
        record.core.markdown_blob_id,
        blobResult.status,
        blobResult.reason
      );
    }
    const blob = blobResult.value;
    const blobIdentity = await deriveMarkdownBlobIdentity(
      boundary.project_id,
      blob.bytes
    );
    if (
      blob.project_id !== boundary.project_id ||
      blob.blob_id !== record.core.markdown_blob_id ||
      blobIdentity.id !== blob.blob_id
    ) {
      throw new CollaborationProjectionError(
        "corrupted_dependency",
        "A revision's Markdown blob does not match its identity or ownership.",
        record.core.markdown_blob_id
      );
    }
    const verified = Object.freeze({
      record,
      markdown_bytes: Uint8Array.from(blob.bytes)
    });
    loaded.set(revisionId, verified);
    for (const parentId of record.core.parent_revision_ids) {
      try {
        await load(parentId, record.core.document_id);
      } catch (error) {
        if (
          record.core.ancestry_kind === "admission_boundary" &&
          error instanceof CollaborationProjectionError &&
          error.code === "missing_dependency"
        ) {
          continue;
        }
        throw error;
      }
    }
    visiting.delete(revisionId);
  };

  for (const revisionId of sortedUnique(rootRevisionIds)) {
    await load(revisionId, expectedDocumentId);
  }
  return Object.freeze({
    revisions: Object.freeze(
      [...loaded.values()].sort((left, right) =>
        compareStrings(left.record.revision_id, right.record.revision_id)
      )
    )
  });
}

export function findVerifiedRevision(
  graph: VerifiedRevisionGraph,
  revisionId: DocumentRevisionId
): VerifiedRevision | null {
  return (
    graph.revisions.find(
      (candidate) => candidate.record.revision_id === revisionId
    ) ?? null
  );
}

export function isRevisionAncestor(
  graph: VerifiedRevisionGraph,
  ancestorId: DocumentRevisionId,
  descendantId: DocumentRevisionId
): boolean {
  if (ancestorId === descendantId) return false;
  const byId = new Map(
    graph.revisions.map((revision) => [revision.record.revision_id, revision])
  );
  const pending = [descendantId];
  const visited = new Set<DocumentRevisionId>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const revision = byId.get(current);
    if (!revision) continue;
    for (const parent of revision.record.core.parent_revision_ids) {
      if (parent === ancestorId) return true;
      pending.push(parent);
    }
  }
  return false;
}

export function findCommonVerifiedAncestor(
  graph: VerifiedRevisionGraph,
  revisionIds: readonly DocumentRevisionId[]
): readonly DocumentRevisionId[] {
  if (revisionIds.length === 0) return Object.freeze([]);
  const ancestorSets = revisionIds.map((revisionId) =>
    revisionAncestorsIncludingSelf(graph, revisionId)
  );
  const common = [...ancestorSets[0]].filter((candidate) =>
    ancestorSets.slice(1).every((set) => set.has(candidate))
  );
  return Object.freeze(common.sort());
}

function revisionAncestorsIncludingSelf(
  graph: VerifiedRevisionGraph,
  revisionId: DocumentRevisionId
): Set<DocumentRevisionId> {
  const byId = new Map(
    graph.revisions.map((revision) => [revision.record.revision_id, revision])
  );
  const output = new Set<DocumentRevisionId>();
  const pending = [revisionId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || output.has(current)) continue;
    output.add(current);
    const revision = byId.get(current);
    if (!revision) continue;
    pending.push(...revision.record.core.parent_revision_ids);
  }
  return output;
}

function revisionReadError(
  id: DocumentRevisionId,
  status: "missing" | "incomplete" | "corrupted" | "mismatched",
  reason: string
): CollaborationProjectionError {
  return new CollaborationProjectionError(
    status === "missing" || status === "incomplete"
      ? "missing_dependency"
      : "corrupted_dependency",
    `Revision ${id} is ${status}: ${reason}`,
    id
  );
}

function blobReadError(
  id: MarkdownBlobId,
  status: "missing" | "incomplete" | "corrupted" | "mismatched",
  reason: string
): CollaborationProjectionError {
  return new CollaborationProjectionError(
    status === "missing" || status === "incomplete"
      ? "missing_dependency"
      : "corrupted_dependency",
    `Markdown blob ${id} is ${status}: ${reason}`,
    id
  );
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import {
  INITIAL_MERGE_ALGORITHM_ID,
  INITIAL_MERGE_ALGORITHM_VERSION,
  bytesToHex,
  calculateMarkdownMergeCandidate,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  parseDocumentRevisionCore,
  type DocumentId,
  type DocumentRevisionId,
  type MarkdownBlobDescription,
  type MarkdownBlobId,
  type ProjectId
} from "../lib/collaboration/index.ts";

export async function evaluateCollaborationMergeVector(): Promise<Readonly<{
  result_bytes_hex: string;
  markdown_blob_id: string;
  revision_id: string;
  merge_key_id: string;
  evidence: readonly string[];
}>> {
  const project = entity("project", "v") as ProjectId;
  const document = entity("document", "v") as DocumentId;
  const revisions = new Map<DocumentRevisionId, import("../lib/collaboration/index.ts").DocumentRevisionRecord>();
  const blobs = new Map<MarkdownBlobId, MarkdownBlobDescription>();
  const addRevision = async (
    markdown: string,
    parents: readonly DocumentRevisionId[],
    ancestryKind: "genesis" | "ordinary"
  ): Promise<DocumentRevisionId> => {
    const bytes = new TextEncoder().encode(markdown);
    const blob = await deriveMarkdownBlobIdentity(project, bytes);
    blobs.set(blob.id, {
      schema_version: 1,
      object_kind: "markdown_blob",
      project_id: project,
      blob_id: blob.id,
      encoding: "utf-8-exact",
      bytes
    });
    const core = parseDocumentRevisionCore({
      schema_version: 1,
      object_kind: "document_revision_core",
      ancestry_kind: ancestryKind,
      project_id: project,
      document_id: document,
      markdown_blob_id: blob.id,
      parent_revision_ids: [...parents].sort()
    });
    const identity = await deriveDocumentRevisionIdentity(core);
    revisions.set(identity.id, {
      record_version: 1,
      object_kind: "document_revision",
      revision_id: identity.id,
      core
    });
    return identity.id;
  };
  const baseMarkdown = "\ufeff# Alpha\r\n\r\nCafé baseline.\r\n\r\n# Beta\r\n\r\nTail.\r\n";
  const base = await addRevision(baseMarkdown, [], "genesis");
  const alpha = await addRevision(
    baseMarkdown.replace("Café baseline.", "Café revised."),
    [base],
    "ordinary"
  );
  const beta = await addRevision(
    baseMarkdown.replace("Tail.", "Tail revised."),
    [base],
    "ordinary"
  );
  const result = await calculateMarkdownMergeCandidate({
    project_id: project,
    document_id: document,
    base_revision_id: base,
    parent_revision_ids: [beta, alpha],
    merge_algorithm_id: INITIAL_MERGE_ALGORITHM_ID,
    merge_algorithm_version: INITIAL_MERGE_ALGORITHM_VERSION,
    async read_revision(id) {
      const value = revisions.get(id);
      return value
        ? { status: "valid" as const, value }
        : { status: "missing" as const, reason: "vector revision missing" };
    },
    async read_blob(projectId, id) {
      const value = blobs.get(id);
      return value && projectId === project
        ? { status: "valid" as const, value }
        : { status: "missing" as const, reason: "vector blob missing" };
    }
  });
  if (result.status !== "candidate" || result.classification !== "proven_safe") {
    throw new Error(`Expected a proven-safe merge vector, received ${result.status}.`);
  }
  return Object.freeze({
    result_bytes_hex: bytesToHex(result.exact_markdown_bytes),
    markdown_blob_id: result.markdown_blob_id,
    revision_id: result.revision_id,
    merge_key_id: result.merge_key_id,
    evidence: result.evidence.operation_descriptions
  });
}

function entity(kind: string, marker: string): string {
  return `pm:${kind}:v1:${"a".repeat(24)}${marker}a`;
}

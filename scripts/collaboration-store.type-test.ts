import type {
  CollaborationByteStorageBackend,
  CollaborationStorageAddress,
  DocumentId,
  DocumentRevisionId,
  LegacyIdentityAlias,
  MarkdownBlobId,
  MergeKeyId,
  ProjectId,
  RevisionReference,
  SemanticEventId
} from "../lib/collaboration/index.ts";
import {
  ImmutableCollaborationStore,
  collaborationObjectAddresses
} from "../lib/collaboration/index.ts";

declare const backend: CollaborationByteStorageBackend;
declare const projectId: ProjectId;
declare const documentId: DocumentId;
declare const blobId: MarkdownBlobId;
declare const revisionId: DocumentRevisionId;
declare const eventId: SemanticEventId;
declare const mergeKeyId: MergeKeyId;
declare const legacyAlias: LegacyIdentityAlias;
declare const address: CollaborationStorageAddress;

const store = new ImmutableCollaborationStore({ backend });
void store.getMarkdownBlob(projectId, blobId);
void store.getRevision(revisionId);
void store.materializeRevisionMarkdown(revisionId);
void collaborationObjectAddresses("markdown-blob", blobId);
void collaborationObjectAddresses("document-revision", revisionId);
void address;

const reference: RevisionReference = {
  schema_version: 1,
  reference_kind: "authored",
  project_id: projectId,
  document_id: documentId,
  revision_id: revisionId,
  event_id: eventId
};
void reference;

// @ts-expect-error Revision IDs cannot address Markdown blob storage.
void store.getMarkdownBlob(projectId, revisionId);
// @ts-expect-error Blob IDs cannot address revision storage.
void store.getRevision(blobId);
// @ts-expect-error Merge-key IDs are separate from revision IDs.
void store.getRevision(mergeKeyId);
// @ts-expect-error Legacy aliases are not authoritative object addresses.
void store.getRevision(legacyAlias);
// @ts-expect-error Arbitrary strings cannot be passed to a byte backend.
void backend.read("patchmark-collaboration/v1/data/document-revision/unsafe");
// @ts-expect-error A merge-key ID is not a semantic event reference.
const invalidReference: RevisionReference = { ...reference, event_id: mergeKeyId };

void invalidReference;

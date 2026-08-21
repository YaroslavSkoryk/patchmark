import type {
  AcknowledgementId,
  AuthenticatedMergeEventReference,
  CheckpointId,
  ControlEventId,
  DeterministicMergeCandidate,
  DocumentRevisionId,
  ExternalMarkdownImportCandidate,
  LegacyIdentityAlias,
  MergeKeyId,
  ProjectId,
  Sha256Digest,
  SemanticEventId,
  SemanticPayloadCore,
  SemanticStateRootId,
  SnapshotId
} from "../lib/collaboration/index.ts";
import {
  buildSignaturePreimage,
  parseEntityId,
  parseSha256Digest
} from "../lib/collaboration/index.ts";

declare const revisionId: DocumentRevisionId;
declare const semanticEventId: SemanticEventId;
declare const controlEventId: ControlEventId;
declare const stateRootId: SemanticStateRootId;
declare const checkpointId: CheckpointId;
declare const mergeCandidate: DeterministicMergeCandidate;
declare const mergeEvent: AuthenticatedMergeEventReference;
declare const externalCandidate: ExternalMarkdownImportCandidate;
declare const legacyAlias: LegacyIdentityAlias;
declare const mergeKeyId: MergeKeyId;
declare const projectId: ProjectId;
declare const acknowledgementId: AcknowledgementId;
declare const snapshotId: SnapshotId;

function requiresSemanticEvent(value: SemanticEventId): void {
  void value;
}
function requiresControlEvent(value: ControlEventId): void {
  void value;
}
function requiresRevision(value: DocumentRevisionId): void {
  void value;
}
function requiresPayload(value: SemanticPayloadCore): void {
  void value;
}
function requiresMergeEvent(value: AuthenticatedMergeEventReference): void {
  void value;
}
function requiresMergeKey(value: MergeKeyId): void {
  void value;
}
function requiresProject(value: ProjectId): void {
  void value;
}
function requiresSha256Digest(value: Sha256Digest): void {
  void value;
}

requiresSemanticEvent(semanticEventId);
requiresControlEvent(controlEventId);
requiresRevision(revisionId);
requiresSemanticEvent(checkpointId);
requiresMergeEvent(mergeEvent);
requiresMergeKey(mergeKeyId);
requiresProject(projectId);
buildSignaturePreimage("semantic_event", projectId, semanticEventId);
buildSignaturePreimage("control_event", projectId, controlEventId);
buildSignaturePreimage("acknowledgement", projectId, acknowledgementId);
buildSignaturePreimage("snapshot", projectId, snapshotId);
requiresSha256Digest(parseSha256Digest(new Uint8Array(32)));

// @ts-expect-error Revision IDs cannot be used as semantic event IDs.
requiresSemanticEvent(revisionId);
// @ts-expect-error Semantic event IDs cannot be used as control event IDs.
requiresControlEvent(semanticEventId);
// @ts-expect-error State roots cannot be used as revision IDs.
requiresRevision(stateRootId);
// @ts-expect-error A general semantic event is not proven to be a checkpoint.
const invalidCheckpoint: CheckpointId = semanticEventId;
// @ts-expect-error A calculated merge candidate is not an authenticated event.
requiresMergeEvent(mergeCandidate);
// @ts-expect-error A device-private external candidate is not a semantic payload.
requiresPayload(externalCandidate);
// @ts-expect-error Merge keys are digest-derived and have no entity-ID parser.
parseEntityId("merge-key", "pm:merge-key:v1:aaaaaaaaaaaaaaaaaaaaaaaaaa");
// @ts-expect-error A scoped legacy alias is not an authoritative project ID.
requiresProject(legacyAlias);
// @ts-expect-error Signature subjects cannot cross digest-ID namespaces.
buildSignaturePreimage("semantic_event", projectId, controlEventId);
// @ts-expect-error Raw mutable bytes are not a branded SHA-256 digest.
requiresSha256Digest(new Uint8Array(32));

void invalidCheckpoint;

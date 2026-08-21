import {
  expectEnum,
  expectLiteral,
  expectNonEmptyString
} from "./validation.ts";
import { decodeSha256Base32 } from "./base32.ts";

declare const collaborationIdBrand: unique symbol;
declare const checkpointIdBrand: unique symbol;

export type CollaborationId<TNamespace extends string> = string & {
  readonly [collaborationIdBrand]: TNamespace;
};

export const entityIdKinds = [
  "project",
  "person",
  "device",
  "public-key",
  "access-scope",
  "group",
  "document",
  "comment",
  "reply",
  "patch",
  "patch-group",
  "patch-version",
  "review-batch",
  "import",
  "rewrite-session",
  "rewrite-review",
  "invitation",
  "membership",
  "key-epoch",
  "external-import-candidate"
] as const;

export const digestIdKinds = [
  "markdown-blob",
  "semantic-payload",
  "control-action",
  "document-revision",
  "semantic-event",
  "control-event",
  "snapshot",
  "acknowledgement",
  "attestation",
  "derived-conflict",
  "semantic-state-root",
  "revision-heads-root",
  "conflict-set-root",
  "frontier-root",
  "accepted-history-root",
  "projection-root",
  "control-state-root",
  "key-epoch-commitment",
  "state-blob",
  "merge-key"
] as const;

export type EntityIdKind = (typeof entityIdKinds)[number];
export type DigestIdKind = (typeof digestIdKinds)[number];

export type ProjectId = CollaborationId<"entity:project">;
export type PersonId = CollaborationId<"entity:person">;
export type DeviceId = CollaborationId<"entity:device">;
export type PublicKeyId = CollaborationId<"entity:public-key">;
export type AccessScopeId = CollaborationId<"entity:access-scope">;
export type GroupId = CollaborationId<"entity:group">;
export type DocumentId = CollaborationId<"entity:document">;
export type CommentId = CollaborationId<"entity:comment">;
export type ReplyId = CollaborationId<"entity:reply">;
export type PatchId = CollaborationId<"entity:patch">;
export type PatchGroupId = CollaborationId<"entity:patch-group">;
export type PatchVersionId = CollaborationId<"entity:patch-version">;
export type ReviewBatchId = CollaborationId<"entity:review-batch">;
export type ImportId = CollaborationId<"entity:import">;
export type RewriteSessionId = CollaborationId<"entity:rewrite-session">;
export type RewriteReviewId = CollaborationId<"entity:rewrite-review">;
export type InvitationId = CollaborationId<"entity:invitation">;
export type MembershipId = CollaborationId<"entity:membership">;
export type KeyEpochId = CollaborationId<"entity:key-epoch">;
export type ExternalImportCandidateId =
  CollaborationId<"entity:external-import-candidate">;

export type MarkdownBlobId = CollaborationId<"digest:markdown-blob">;
export type SemanticPayloadId = CollaborationId<"digest:semantic-payload">;
export type ControlActionId = CollaborationId<"digest:control-action">;
export type DocumentRevisionId = CollaborationId<"digest:document-revision">;
export type SemanticEventId = CollaborationId<"digest:semantic-event">;
export type ControlEventId = CollaborationId<"digest:control-event">;
export type SnapshotId = CollaborationId<"digest:snapshot">;
export type AcknowledgementId = CollaborationId<"digest:acknowledgement">;
export type AttestationId = CollaborationId<"digest:attestation">;
export type DerivedConflictId = CollaborationId<"digest:derived-conflict">;
export type SemanticStateRootId =
  CollaborationId<"digest:semantic-state-root">;
export type RevisionHeadsRootId =
  CollaborationId<"digest:revision-heads-root">;
export type ConflictSetRootId = CollaborationId<"digest:conflict-set-root">;
export type FrontierRootId = CollaborationId<"digest:frontier-root">;
export type AcceptedHistoryRootId =
  CollaborationId<"digest:accepted-history-root">;
export type ProjectionRootId = CollaborationId<"digest:projection-root">;
export type ControlStateRootId =
  CollaborationId<"digest:control-state-root">;
export type KeyEpochCommitmentId =
  CollaborationId<"digest:key-epoch-commitment">;
export type StateBlobId = CollaborationId<"digest:state-blob">;
export type MergeKeyId = CollaborationId<"digest:merge-key">;

export type CheckpointId = SemanticEventId & {
  readonly [checkpointIdBrand]: "consolidation-checkpoint";
};

export type EntityIdByKind = {
  project: ProjectId;
  person: PersonId;
  device: DeviceId;
  "public-key": PublicKeyId;
  "access-scope": AccessScopeId;
  group: GroupId;
  document: DocumentId;
  comment: CommentId;
  reply: ReplyId;
  patch: PatchId;
  "patch-group": PatchGroupId;
  "patch-version": PatchVersionId;
  "review-batch": ReviewBatchId;
  import: ImportId;
  "rewrite-session": RewriteSessionId;
  "rewrite-review": RewriteReviewId;
  invitation: InvitationId;
  membership: MembershipId;
  "key-epoch": KeyEpochId;
  "external-import-candidate": ExternalImportCandidateId;
};

export type DigestIdByKind = {
  "markdown-blob": MarkdownBlobId;
  "semantic-payload": SemanticPayloadId;
  "control-action": ControlActionId;
  "document-revision": DocumentRevisionId;
  "semantic-event": SemanticEventId;
  "control-event": ControlEventId;
  snapshot: SnapshotId;
  acknowledgement: AcknowledgementId;
  attestation: AttestationId;
  "derived-conflict": DerivedConflictId;
  "semantic-state-root": SemanticStateRootId;
  "revision-heads-root": RevisionHeadsRootId;
  "conflict-set-root": ConflictSetRootId;
  "frontier-root": FrontierRootId;
  "accepted-history-root": AcceptedHistoryRootId;
  "projection-root": ProjectionRootId;
  "control-state-root": ControlStateRootId;
  "key-epoch-commitment": KeyEpochCommitmentId;
  "state-blob": StateBlobId;
  "merge-key": MergeKeyId;
};

const entityIdPattern = /^[a-z2-7]{25}[aiqy]$/;

export function parseEntityId<TKind extends EntityIdKind>(
  kind: TKind,
  value: unknown
): EntityIdByKind[TKind] {
  const parsedKind = expectEnum(kind, entityIdKinds, "entity ID kind");
  const text = expectNonEmptyString(value, `${parsedKind} ID`);
  const prefix = `pm:${parsedKind}:v1:`;
  if (!text.startsWith(prefix) || !entityIdPattern.test(text.slice(prefix.length))) {
    throw new Error(`${parsedKind} ID must use the canonical ${prefix} namespace.`);
  }
  return text as EntityIdByKind[TKind];
}

export function parseDigestId<TKind extends DigestIdKind>(
  kind: TKind,
  value: unknown
): DigestIdByKind[TKind] {
  const parsedKind = expectEnum(kind, digestIdKinds, "digest ID kind");
  const text = expectNonEmptyString(value, `${parsedKind} ID`);
  const prefix = `pm:${parsedKind}:v1:`;
  if (!text.startsWith(prefix)) {
    throw new Error(`${parsedKind} ID must use the canonical ${prefix} namespace.`);
  }
  try {
    decodeSha256Base32(text.slice(prefix.length));
  } catch {
    throw new Error(`${parsedKind} ID must use the canonical ${prefix} namespace.`);
  }
  return text as DigestIdByKind[TKind];
}

export function checkpointIdFromConsolidationEvent(
  eventId: SemanticEventId,
  semanticKind: string
): CheckpointId {
  if (semanticKind !== "consolidation_checkpoint") {
    throw new Error(
      "A checkpoint ID must be the semantic event ID of a consolidation checkpoint."
    );
  }
  return eventId as CheckpointId;
}

export function assertIdentityFormatVersion(value: unknown): void {
  expectLiteral(value, 1, "identity format version");
}

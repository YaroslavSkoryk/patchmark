import {
  parseDigestId,
  parseEntityId,
  type AcknowledgementId,
  type AttestationId,
  type ControlActionId,
  type ControlEventId,
  type DeviceId,
  type DocumentRevisionId,
  type MarkdownBlobId,
  type ProjectId,
  type SemanticEventId,
  type SemanticPayloadId,
  type SnapshotId,
  type StateBlobId
} from "./identities.ts";

declare const collaborationStorageAddressBrand: unique symbol;
declare const collaborationStoragePrefixBrand: unique symbol;

export type CollaborationStorageAddress = string & {
  readonly [collaborationStorageAddressBrand]: "collaboration-storage-address";
};

export type CollaborationStoragePrefix = string & {
  readonly [collaborationStoragePrefixBrand]: "collaboration-storage-prefix";
};

/** Slice 3 object families retained for its focused store API. */
export type CollaborationStoredObjectKind =
  | "markdown-blob"
  | "document-revision";

export type CollaborationEventObjectKind =
  | "semantic-payload"
  | "control-action"
  | "semantic-event"
  | "control-event"
  | "attestation";

export type CollaborationConsolidationObjectKind =
  | "state-blob"
  | "snapshot"
  | "acknowledgement";

export type CollaborationObjectKind =
  | CollaborationStoredObjectKind
  | CollaborationEventObjectKind
  | CollaborationConsolidationObjectKind;

export type CollaborationObjectIdByKind = {
  "markdown-blob": MarkdownBlobId;
  "document-revision": DocumentRevisionId;
  "semantic-payload": SemanticPayloadId;
  "control-action": ControlActionId;
  "semantic-event": SemanticEventId;
  "control-event": ControlEventId;
  attestation: AttestationId;
  "state-blob": StateBlobId;
  snapshot: SnapshotId;
  acknowledgement: AcknowledgementId;
};

export type CollaborationObjectId =
  CollaborationObjectIdByKind[CollaborationObjectKind];

export type CollaborationAddressedObject = {
  [TKind in CollaborationObjectKind]: Readonly<{
    kind: TKind;
    id: CollaborationObjectIdByKind[TKind];
  }>;
}[CollaborationObjectKind];

export type CollaborationByteWriteContext = Readonly<{
  stage:
    | "staging"
    | "object_data"
    | "commit_marker"
    | "derived_index"
    | "sequence_reservation";
}>;

export interface CollaborationByteStorageBackend {
  read(address: CollaborationStorageAddress): Promise<Uint8Array | null>;
  write(
    address: CollaborationStorageAddress,
    bytes: Uint8Array,
    context: CollaborationByteWriteContext
  ): Promise<void>;
  delete(address: CollaborationStorageAddress): Promise<void>;
  list(prefix: CollaborationStoragePrefix): Promise<readonly CollaborationStorageAddress[]>;
}

export type CollaborationStoreFailureStage =
  | "before_first_write"
  | "after_write_before_verification"
  | "after_verification_before_committed_visibility"
  | "after_object_commit_before_index_update"
  | "during_recovery";

export type CollaborationStoreFailureContext = Readonly<{
  stage: CollaborationStoreFailureStage;
  object_kind?: CollaborationObjectKind;
  object_id?: CollaborationObjectId;
}>;

export type CollaborationStoreFailureInjector = (
  context: CollaborationStoreFailureContext
) => void | Promise<void>;

export type CollaborationReadFailureStatus =
  | "missing"
  | "incomplete"
  | "corrupted"
  | "mismatched";

export type CollaborationReadResult<T> =
  | Readonly<{ status: "valid"; value: T }>
  | Readonly<{
      status: CollaborationReadFailureStatus;
      reason: string;
    }>;

export type CollaborationPutResult<TId extends string, TValue> = Readonly<{
  status: "stored" | "already_present";
  id: TId;
  value: TValue;
}>;

export type CollaborationStoreErrorCode =
  | "backend_failed"
  | "chain_blocked"
  | "corrupted"
  | "dependency_invalid"
  | "dependency_missing"
  | "incomplete"
  | "mismatched"
  | "not_found"
  | "ownership_mismatch"
  | "reservation_conflict"
  | "self_reference";

export class CollaborationStoreError extends Error {
  readonly code: CollaborationStoreErrorCode;
  readonly cause?: unknown;

  constructor(code: CollaborationStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "CollaborationStoreError";
    this.code = code;
    this.cause = cause;
  }
}

const root = "patchmark-collaboration/v1/";
const objectKinds = [
  "markdown-blob",
  "document-revision",
  "semantic-payload",
  "control-action",
  "semantic-event",
  "control-event",
  "attestation",
  "state-blob",
  "snapshot",
  "acknowledgement"
] as const satisfies readonly CollaborationObjectKind[];
const objectKindPattern = objectKinds.join("|");
const objectAddressPattern = new RegExp(
  `^patchmark-collaboration/v1/(data|commits|staging)/(${objectKindPattern})/([a-z2-7]{52})$`
);
const revisionIndexAddressPattern = /^patchmark-collaboration\/v1\/indexes\/revision-references\/([a-z2-7]{52})$/;
const projectStateAddressPattern = /^patchmark-collaboration\/v1\/indexes\/event-control-state\/([a-z2-7]{25}[aiqy])$/;
const reservationAddressPattern = /^patchmark-collaboration\/v1\/reservations\/semantic\/([a-z2-7]{25}[aiqy])\/([a-z2-7]{25}[aiqy])$/;
const acknowledgementReservationAddressPattern = /^patchmark-collaboration\/v1\/reservations\/acknowledgement\/([a-z2-7]{25}[aiqy])\/([a-z2-7]{25}[aiqy])$/;

export const collaborationStoragePrefixes = Object.freeze({
  root: asPrefix(root),
  data: asPrefix(`${root}data/`),
  commits: asPrefix(`${root}commits/`),
  staging: asPrefix(`${root}staging/`),
  revisionReferenceIndexes: asPrefix(`${root}indexes/revision-references/`),
  eventControlStateIndexes: asPrefix(`${root}indexes/event-control-state/`),
  semanticReservations: asPrefix(`${root}reservations/semantic/`),
  acknowledgementReservations: asPrefix(`${root}reservations/acknowledgement/`)
});

export function collaborationObjectAddresses<TKind extends CollaborationObjectKind>(
  kind: TKind,
  id: CollaborationObjectIdByKind[TKind]
): Readonly<{
  data: CollaborationStorageAddress;
  commit: CollaborationStorageAddress;
  staging: CollaborationStorageAddress;
}> {
  const parsed = parseCollaborationObjectId(kind, id);
  const digest = parsed.slice(parsed.lastIndexOf(":") + 1);
  return Object.freeze({
    data: asAddress(`${root}data/${kind}/${digest}`),
    commit: asAddress(`${root}commits/${kind}/${digest}`),
    staging: asAddress(`${root}staging/${kind}/${digest}`)
  });
}

export function collaborationRevisionReferenceIndexAddress(
  id: DocumentRevisionId
): CollaborationStorageAddress {
  const parsed = parseDigestId("document-revision", id);
  return asAddress(
    `${root}indexes/revision-references/${digestSuffix(parsed)}`
  );
}

export function collaborationEventControlStateIndexAddress(
  projectId: ProjectId
): CollaborationStorageAddress {
  const project = parseEntityId("project", projectId);
  return asAddress(`${root}indexes/event-control-state/${entitySuffix(project)}`);
}

export function collaborationSemanticReservationAddress(
  projectId: ProjectId,
  deviceId: DeviceId
): CollaborationStorageAddress {
  const project = parseEntityId("project", projectId);
  const device = parseEntityId("device", deviceId);
  return asAddress(
    `${root}reservations/semantic/${entitySuffix(project)}/${entitySuffix(device)}`
  );
}

export function collaborationAcknowledgementReservationAddress(
  projectId: ProjectId,
  deviceId: DeviceId
): CollaborationStorageAddress {
  const project = parseEntityId("project", projectId);
  const device = parseEntityId("device", deviceId);
  return asAddress(
    `${root}reservations/acknowledgement/${entitySuffix(project)}/${entitySuffix(device)}`
  );
}

export function parseCollaborationStorageAddress(
  value: unknown
): CollaborationStorageAddress {
  if (typeof value !== "string") {
    throw new Error("Collaboration storage addresses must be strings.");
  }
  const objectMatch = objectAddressPattern.exec(value);
  if (objectMatch) {
    const kind = parseCollaborationObjectKind(objectMatch[2]);
    parseCollaborationObjectId(kind, `pm:${kind}:v1:${objectMatch[3]}`);
    return value as CollaborationStorageAddress;
  }
  const revisionMatch = revisionIndexAddressPattern.exec(value);
  if (revisionMatch) {
    parseDigestId(
      "document-revision",
      `pm:document-revision:v1:${revisionMatch[1]}`
    );
    return value as CollaborationStorageAddress;
  }
  const projectMatch = projectStateAddressPattern.exec(value);
  if (projectMatch) {
    parseEntityId("project", `pm:project:v1:${projectMatch[1]}`);
    return value as CollaborationStorageAddress;
  }
  const reservationMatch = reservationAddressPattern.exec(value);
  if (reservationMatch) {
    parseEntityId("project", `pm:project:v1:${reservationMatch[1]}`);
    parseEntityId("device", `pm:device:v1:${reservationMatch[2]}`);
    return value as CollaborationStorageAddress;
  }
  const acknowledgementReservationMatch = acknowledgementReservationAddressPattern.exec(value);
  if (acknowledgementReservationMatch) {
    parseEntityId("project", `pm:project:v1:${acknowledgementReservationMatch[1]}`);
    parseEntityId("device", `pm:device:v1:${acknowledgementReservationMatch[2]}`);
    return value as CollaborationStorageAddress;
  }
  throw new Error("Value is outside the Patchmark collaboration storage namespace.");
}

export function objectIdFromStorageAddress(
  value: CollaborationStorageAddress
): CollaborationAddressedObject | null {
  const address = parseCollaborationStorageAddress(value);
  const match = objectAddressPattern.exec(address);
  if (!match) return null;
  const kind = parseCollaborationObjectKind(match[2]);
  const id = parseCollaborationObjectId(
    kind,
    `pm:${kind}:v1:${match[3]}`
  );
  return Object.freeze({ kind, id }) as CollaborationAddressedObject;
}

export function parseCollaborationObjectKind(
  value: unknown
): CollaborationObjectKind {
  if (
    typeof value !== "string" ||
    !objectKinds.includes(value as CollaborationObjectKind)
  ) {
    throw new Error("Unsupported collaboration stored-object kind.");
  }
  return value as CollaborationObjectKind;
}

export function parseCollaborationObjectId<TKind extends CollaborationObjectKind>(
  kind: TKind,
  value: unknown
): CollaborationObjectIdByKind[TKind] {
  switch (kind) {
    case "markdown-blob":
      return parseDigestId("markdown-blob", value) as CollaborationObjectIdByKind[TKind];
    case "document-revision":
      return parseDigestId("document-revision", value) as CollaborationObjectIdByKind[TKind];
    case "semantic-payload":
      return parseDigestId("semantic-payload", value) as CollaborationObjectIdByKind[TKind];
    case "control-action":
      return parseDigestId("control-action", value) as CollaborationObjectIdByKind[TKind];
    case "semantic-event":
      return parseDigestId("semantic-event", value) as CollaborationObjectIdByKind[TKind];
    case "control-event":
      return parseDigestId("control-event", value) as CollaborationObjectIdByKind[TKind];
    case "attestation":
      return parseDigestId("attestation", value) as CollaborationObjectIdByKind[TKind];
    case "state-blob":
      return parseDigestId("state-blob", value) as CollaborationObjectIdByKind[TKind];
    case "snapshot":
      return parseDigestId("snapshot", value) as CollaborationObjectIdByKind[TKind];
    case "acknowledgement":
      return parseDigestId("acknowledgement", value) as CollaborationObjectIdByKind[TKind];
  }
}

function digestSuffix(value: string): string {
  return value.slice(value.lastIndexOf(":") + 1);
}

function entitySuffix(value: string): string {
  return value.slice(value.lastIndexOf(":") + 1);
}

function asAddress(value: string): CollaborationStorageAddress {
  return parseCollaborationStorageAddress(value);
}

function asPrefix(value: string): CollaborationStoragePrefix {
  if (!value.startsWith(root) || value.includes("..") || value.includes("\\")) {
    throw new Error("Invalid collaboration storage prefix.");
  }
  return value as CollaborationStoragePrefix;
}

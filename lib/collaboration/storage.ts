import {
  parseDigestId,
  type DocumentRevisionId,
  type MarkdownBlobId
} from "./identities.ts";

declare const collaborationStorageAddressBrand: unique symbol;
declare const collaborationStoragePrefixBrand: unique symbol;

export type CollaborationStorageAddress = string & {
  readonly [collaborationStorageAddressBrand]: "collaboration-storage-address";
};

export type CollaborationStoragePrefix = string & {
  readonly [collaborationStoragePrefixBrand]: "collaboration-storage-prefix";
};

export type CollaborationStoredObjectKind =
  | "markdown-blob"
  | "document-revision";

export type CollaborationByteWriteContext = Readonly<{
  stage: "staging" | "object_data" | "commit_marker" | "derived_index";
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
  object_kind?: CollaborationStoredObjectKind;
  object_id?: MarkdownBlobId | DocumentRevisionId;
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
  | "corrupted"
  | "dependency_invalid"
  | "dependency_missing"
  | "incomplete"
  | "mismatched"
  | "not_found"
  | "ownership_mismatch"
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
const objectAddressPattern = /^patchmark-collaboration\/v1\/(data|commits|staging)\/(markdown-blob|document-revision)\/([a-z2-7]{52})$/;
const indexAddressPattern = /^patchmark-collaboration\/v1\/indexes\/revision-references\/([a-z2-7]{52})$/;

export const collaborationStoragePrefixes = Object.freeze({
  root: asPrefix(root),
  data: asPrefix(`${root}data/`),
  commits: asPrefix(`${root}commits/`),
  staging: asPrefix(`${root}staging/`),
  revisionReferenceIndexes: asPrefix(`${root}indexes/revision-references/`)
});

export function collaborationObjectAddresses(
  kind: "markdown-blob",
  id: MarkdownBlobId
): Readonly<{
  data: CollaborationStorageAddress;
  commit: CollaborationStorageAddress;
  staging: CollaborationStorageAddress;
}>;
export function collaborationObjectAddresses(
  kind: "document-revision",
  id: DocumentRevisionId
): Readonly<{
  data: CollaborationStorageAddress;
  commit: CollaborationStorageAddress;
  staging: CollaborationStorageAddress;
}>;
export function collaborationObjectAddresses(
  kind: CollaborationStoredObjectKind,
  id: MarkdownBlobId | DocumentRevisionId
) {
  const parsed = kind === "markdown-blob"
    ? parseDigestId("markdown-blob", id)
    : parseDigestId("document-revision", id);
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
    `${root}indexes/revision-references/${parsed.slice(parsed.lastIndexOf(":") + 1)}`
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
    const kind = objectMatch[2] as CollaborationStoredObjectKind;
    parseDigestId(kind, `pm:${kind}:v1:${objectMatch[3]}`);
    return value as CollaborationStorageAddress;
  }
  const indexMatch = indexAddressPattern.exec(value);
  if (indexMatch) {
    parseDigestId(
      "document-revision",
      `pm:document-revision:v1:${indexMatch[1]}`
    );
    return value as CollaborationStorageAddress;
  }
  throw new Error("Value is outside the Patchmark collaboration storage namespace.");
}

export function objectIdFromStorageAddress(
  value: CollaborationStorageAddress
): Readonly<{
  kind: CollaborationStoredObjectKind;
  id: MarkdownBlobId | DocumentRevisionId;
}> | null {
  const address = parseCollaborationStorageAddress(value);
  const match = objectAddressPattern.exec(address);
  if (!match) return null;
  const kind = match[2] as CollaborationStoredObjectKind;
  const id = kind === "markdown-blob"
    ? parseDigestId("markdown-blob", `pm:${kind}:v1:${match[3]}`)
    : parseDigestId("document-revision", `pm:${kind}:v1:${match[3]}`);
  return Object.freeze({ kind, id });
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

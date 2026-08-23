import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectIdByKind,
  type CollaborationObjectKind
} from "../storage.ts";
import {
  hc2DigestSuffix,
  parseHc2DigestId,
  parseOperationId,
  type ObjectCommitMarkerId,
  type OperationId,
  type PortableBatchId,
  type RecoveryEnvelopeId,
  type WriterContinuityId
} from "./identities.ts";
import { HC2_FOLDER_ROOT } from "./versions.ts";

declare const portableAddressBrand: unique symbol;
export type Hc2PortableAddress = string & { readonly [portableAddressBrand]: "hc2-portable-address" };

export type ParsedHc2PortableAddress =
  | Readonly<{ namespace: "replica" }>
  | Readonly<{ namespace: "object"; stage: "data" | "commits" | "staging"; kind: CollaborationObjectKind; id: CollaborationObjectIdByKind[CollaborationObjectKind] }>
  | Readonly<{ namespace: "batch"; id: PortableBatchId }>
  | Readonly<{ namespace: "transaction"; operation_id: OperationId }>
  | Readonly<{ namespace: "recovery"; epoch_tag: string; recipient_tag: string; id: RecoveryEnvelopeId }>
  | Readonly<{ namespace: "continuity"; id: WriterContinuityId }>
  | Readonly<{ namespace: "materialization" }>
  | Readonly<{ namespace: "index"; index_kind: "control" | "object-catalog" | "revision" | "semantic"; digest: string }>
  | Readonly<{ namespace: "cache"; cache_kind: "objects" | "projector"; digest: string }>;

const digest = "[a-z2-7]{52}";
const objectKinds = "markdown-blob|document-revision|semantic-payload|control-action|semantic-event|control-event|attestation|state-blob|snapshot|acknowledgement";
const objectPattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}(data|commits|staging)/(${objectKinds})/(${digest})$`);
const batchPattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}batches/(${digest})$`);
const transactionPattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}transactions/([a-z2-7]{26})/intent\\.cbor$`);
const recoveryPattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}recovery/epochs/(${digest})/(${digest})/(${digest})$`);
const continuityPattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}continuity/writers/(${digest})$`);
const indexPattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}indexes/(control|object-catalog|revision|semantic)/(${digest})$`);
const cachePattern = new RegExp(`^${escapeRegex(HC2_FOLDER_ROOT)}cache/(objects|projector)/(${digest})$`);

export const hc2ReplicaMetadataAddress = parseHc2PortableAddress(`${HC2_FOLDER_ROOT}replica.cbor`);
export const hc2MaterializationStatusAddress = parseHc2PortableAddress(`${HC2_FOLDER_ROOT}materialization/current.cbor`);

export function hc2ObjectAddresses<TKind extends CollaborationObjectKind>(
  kind: TKind,
  id: CollaborationObjectIdByKind[TKind]
): Readonly<{ data: Hc2PortableAddress; commit: Hc2PortableAddress; staging: Hc2PortableAddress }> {
  const parsedKind = parseCollaborationObjectKind(kind);
  const parsedId = parseCollaborationObjectId(parsedKind, id);
  const suffix = parsedId.slice(parsedId.lastIndexOf(":") + 1);
  return Object.freeze({
    data: parseHc2PortableAddress(`${HC2_FOLDER_ROOT}data/${parsedKind}/${suffix}`),
    commit: parseHc2PortableAddress(`${HC2_FOLDER_ROOT}commits/${parsedKind}/${suffix}`),
    staging: parseHc2PortableAddress(`${HC2_FOLDER_ROOT}staging/${parsedKind}/${suffix}`)
  });
}

export function hc2BatchAddress(id: PortableBatchId): Hc2PortableAddress {
  return parseHc2PortableAddress(`${HC2_FOLDER_ROOT}batches/${hc2DigestSuffix("portable-batch", id)}`);
}

export function hc2TransactionIntentAddress(id: OperationId): Hc2PortableAddress {
  return parseHc2PortableAddress(`${HC2_FOLDER_ROOT}transactions/${parseOperationId(id)}/intent.cbor`);
}

export function hc2RecoveryEnvelopeAddress(input: Readonly<{
  epoch_tag: string;
  recipient_tag: string;
  envelope_id: RecoveryEnvelopeId;
}>): Hc2PortableAddress {
  const epoch = parseAddressDigest(input.epoch_tag, "epoch routing tag");
  const recipient = parseAddressDigest(input.recipient_tag, "recipient routing tag");
  const envelope = hc2DigestSuffix("recovery-envelope", input.envelope_id);
  return parseHc2PortableAddress(`${HC2_FOLDER_ROOT}recovery/epochs/${epoch}/${recipient}/${envelope}`);
}

export function hc2WriterContinuityAddress(id: WriterContinuityId): Hc2PortableAddress {
  return parseHc2PortableAddress(`${HC2_FOLDER_ROOT}continuity/writers/${hc2DigestSuffix("writer-continuity", id)}`);
}

export function hc2RebuildableIndexAddress(
  kind: "control" | "object-catalog" | "revision" | "semantic",
  addressDigest: string
): Hc2PortableAddress {
  return parseHc2PortableAddress(`${HC2_FOLDER_ROOT}indexes/${kind}/${parseAddressDigest(addressDigest, "index digest")}`);
}

export function hc2CacheAddress(
  kind: "objects" | "projector",
  addressDigest: string
): Hc2PortableAddress {
  return parseHc2PortableAddress(`${HC2_FOLDER_ROOT}cache/${kind}/${parseAddressDigest(addressDigest, "cache digest")}`);
}

export function parseHc2PortableAddress(value: unknown): Hc2PortableAddress {
  parseHc2PortableAddressDetails(value);
  return value as Hc2PortableAddress;
}

export function parseHc2PortableAddressDetails(value: unknown): ParsedHc2PortableAddress {
  if (typeof value !== "string" || value.normalize("NFC") !== value || value.includes("\\") || value.includes("..") || value.startsWith("/")) {
    throw new Error("Invalid HC-2 portable address.");
  }
  if (value === `${HC2_FOLDER_ROOT}replica.cbor`) return Object.freeze({ namespace: "replica" });
  if (value === `${HC2_FOLDER_ROOT}materialization/current.cbor`) return Object.freeze({ namespace: "materialization" });
  const object = objectPattern.exec(value);
  if (object) {
    const stage = object[1] as "data" | "commits" | "staging";
    const kind = parseCollaborationObjectKind(object[2]);
    const id = parseCollaborationObjectId(kind, `pm:${kind}:v1:${object[3]}`);
    return Object.freeze({ namespace: "object", stage, kind, id }) as ParsedHc2PortableAddress;
  }
  const batch = batchPattern.exec(value);
  if (batch) return Object.freeze({ namespace: "batch", id: parseHc2DigestId("portable-batch", `pm:portable-batch:v1:${batch[1]}`) });
  const transaction = transactionPattern.exec(value);
  if (transaction) return Object.freeze({ namespace: "transaction", operation_id: parseOperationId(transaction[1]) });
  const recovery = recoveryPattern.exec(value);
  if (recovery) return Object.freeze({
    namespace: "recovery",
    epoch_tag: parseAddressDigest(recovery[1], "epoch routing tag"),
    recipient_tag: parseAddressDigest(recovery[2], "recipient routing tag"),
    id: parseHc2DigestId("recovery-envelope", `pm:recovery-envelope:v1:${recovery[3]}`)
  });
  const continuity = continuityPattern.exec(value);
  if (continuity) return Object.freeze({ namespace: "continuity", id: parseHc2DigestId("writer-continuity", `pm:writer-continuity:v1:${continuity[1]}`) });
  const index = indexPattern.exec(value);
  if (index) return Object.freeze({ namespace: "index", index_kind: index[1] as "control" | "object-catalog" | "revision" | "semantic", digest: parseAddressDigest(index[2], "index digest") });
  const cache = cachePattern.exec(value);
  if (cache) return Object.freeze({ namespace: "cache", cache_kind: cache[1] as "objects" | "projector", digest: parseAddressDigest(cache[2], "cache digest") });
  throw new Error("Value is outside the HC-2 portable folder namespace.");
}

export function parseObjectCommitMarkerId(value: unknown): ObjectCommitMarkerId {
  return parseHc2DigestId("object-commit-marker", value);
}

function parseAddressDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z2-7]{52}$/.test(value)) {
    throw new Error(`${label} must use lowercase unpadded SHA-256 Base32.`);
  }
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

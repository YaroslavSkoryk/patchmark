import { decodeCanonicalCbor, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import type { ProjectId } from "../identities.ts";
import { parseEntityId } from "../identities.ts";
import { parseCollaborationObjectId, parseCollaborationObjectKind, type CollaborationObjectId } from "../storage.ts";
import { parseSha256Digest, sha256, type Sha256Digest } from "../sha256.ts";
import { expectArray, expectBytes, expectExactRecord, expectLiteral } from "../validation.ts";
import {
  decodeTransportPayloadCoreV2,
  encodeTransportPayloadCoreV2,
  type AdmissionAttachmentPayloadV2,
  type EpochDeliveryAttachmentPayloadV2,
  type ReceiptAttachmentPayloadV2
} from "./transport-v2-contracts.ts";
import {
  deriveTransportV2Identity,
  parseTransportV2Id,
  transportV2IdSuffix,
  type BundleManifestIdV2,
  type TransportAttachmentBatchIdV2,
  type TransportAttachmentIdV2,
  type TransportPayloadIdV2
} from "./transport-v2-identities.ts";
import { HC2_TRANSPORT_SCHEMA_VERSION } from "./transport-v2-versions.ts";

export type TransportAttachmentPayloadV2 =
  | AdmissionAttachmentPayloadV2
  | EpochDeliveryAttachmentPayloadV2
  | ReceiptAttachmentPayloadV2;

export type TransportAttachmentRecordV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "transport_attachment_record_v2";
  project_id: ProjectId;
  payload_id: TransportPayloadIdV2;
  attachment_id: TransportAttachmentIdV2;
  payload_kind: TransportAttachmentPayloadV2["payload_kind"];
  exact_payload_bytes: Uint8Array;
  exact_payload_sha256: Sha256Digest;
}>;

export type TransportAttachmentBatchMarkerV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "transport_attachment_batch_marker_v2";
  project_id: ProjectId;
  manifest_id: BundleManifestIdV2;
  attachment_ids: readonly TransportAttachmentIdV2[];
  hc1_object_ids: readonly CollaborationObjectId[];
  batch_id: TransportAttachmentBatchIdV2;
}>;

export interface TransportAttachmentByteBackend {
  read(address: string): Promise<Uint8Array | null>;
  write(address: string, bytes: Uint8Array): Promise<void>;
  delete(address: string): Promise<void>;
}

export class InMemoryTransportAttachmentByteBackend implements TransportAttachmentByteBackend {
  readonly #bytes = new Map<string, Uint8Array>();
  async read(address: string): Promise<Uint8Array | null> { const value = this.#bytes.get(address); return value ? Uint8Array.from(value) : null; }
  async write(address: string, bytes: Uint8Array): Promise<void> { this.#bytes.set(address, Uint8Array.from(bytes)); }
  async delete(address: string): Promise<void> { this.#bytes.delete(address); }
}

export class PortableTransportAttachmentStoreV2 {
  readonly #backend: TransportAttachmentByteBackend;
  readonly #failure?: (stage: "after_staging" | "after_data" | "after_attachment_marker" | "before_batch_marker") => void | Promise<void>;

  constructor(input: Readonly<{
    backend: TransportAttachmentByteBackend;
    inject_failure?: (stage: "after_staging" | "after_data" | "after_attachment_marker" | "before_batch_marker") => void | Promise<void>;
  }>) {
    this.#backend = input.backend;
    this.#failure = input.inject_failure;
  }

  async createAttachment(projectId: ProjectId, payload: TransportAttachmentPayloadV2): Promise<TransportAttachmentRecordV2> {
    const project = parseEntityId("project", projectId);
    const parsed = decodeTransportPayloadCoreV2(encodeTransportPayloadCoreV2(payload));
    if (parsed.payload_kind === "bundle_manifest" || parsed.payload_kind === "hc1_object_chunk") throw new Error("HC-1 chunks and manifests cannot enter the HC-2 attachment store.");
    const bytes = encodeTransportPayloadCoreV2(parsed);
    const [payloadIdentity, attachmentIdentity, digest] = await Promise.all([
      deriveTransportV2Identity("transport-payload", canonicalProtocolValue(parsed)),
      deriveTransportV2Identity("transport-attachment", canonicalProtocolValue(Object.freeze({ project_id: project, payload_kind: parsed.payload_kind, exact_payload_bytes: bytes }))),
      sha256(bytes)
    ]);
    return Object.freeze({
      schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "transport_attachment_record_v2",
      project_id: project,
      payload_id: payloadIdentity.id,
      attachment_id: attachmentIdentity.id,
      payload_kind: parsed.payload_kind,
      exact_payload_bytes: Uint8Array.from(bytes),
      exact_payload_sha256: digest
    });
  }

  async commitBatch(input: Readonly<{
    project_id: ProjectId;
    manifest_id: BundleManifestIdV2;
    attachments: readonly TransportAttachmentRecordV2[];
    hc1_object_ids: readonly CollaborationObjectId[];
    before_visibility?: () => Promise<void>;
  }>): Promise<TransportAttachmentBatchMarkerV2> {
    const project = parseEntityId("project", input.project_id);
    const manifest = parseTransportV2Id("bundle-manifest", input.manifest_id);
    if (!Array.isArray(input.attachments) || !Array.isArray(input.hc1_object_ids)) throw new Error("Transport import batch is malformed.");
    const attachments = [...input.attachments].sort((left, right) => compareAscii(left.attachment_id, right.attachment_id));
    if (new Set(attachments.map((entry) => entry.attachment_id)).size !== attachments.length) throw new Error("Transport import batch contains duplicate attachments.");
    for (const attachment of attachments) {
      const verified = await this.verifyRecord(attachment, project);
      const addresses = attachmentAddresses(verified.payload_kind, verified.attachment_id);
      const encoded = encodeCanonicalCbor(canonicalProtocolValue(verified));
      await this.#backend.write(addresses.staging, encoded);
      await this.#failure?.("after_staging");
      const staged = await this.#backend.read(addresses.staging);
      if (!staged || !sameBytes(staged, encoded)) throw new Error("Staged HC-2 attachment did not reopen byte-identically.");
      const existing = await this.#backend.read(addresses.data);
      if (existing && !sameBytes(existing, encoded)) throw new Error("HC-2 attachment address collision.");
      if (!existing) await this.#backend.write(addresses.data, encoded);
      await this.#failure?.("after_data");
      const markerCore = Object.freeze({
        schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
        record_kind: "transport_attachment_commit_marker_v2",
        project_id: project,
        payload_kind: verified.payload_kind,
        attachment_id: verified.attachment_id,
        exact_record_sha256: await sha256(encoded)
      });
      const markerIdentity = await deriveTransportV2Identity("transport-attachment-marker", canonicalProtocolValue(markerCore));
      const marker = Object.freeze({ ...markerCore, marker_id: markerIdentity.id });
      const markerBytes = encodeCanonicalCbor(canonicalProtocolValue(marker));
      const markerExisting = await this.#backend.read(addresses.commit);
      if (markerExisting && !sameBytes(markerExisting, markerBytes)) throw new Error("HC-2 attachment commit-marker collision.");
      if (!markerExisting) await this.#backend.write(addresses.commit, markerBytes);
      await this.#failure?.("after_attachment_marker");
      await this.#backend.delete(addresses.staging);
    }
    const hc1Ids = input.hc1_object_ids.map(parseHc1ObjectId).sort();
    if (new Set(hc1Ids).size !== hc1Ids.length) throw new Error("Transport import batch contains duplicate HC-1 object IDs.");
    const core = Object.freeze({
      schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "transport_attachment_batch_core_v2",
      project_id: project,
      manifest_id: manifest,
      attachment_ids: Object.freeze(attachments.map((entry) => entry.attachment_id)),
      hc1_object_ids: Object.freeze(hc1Ids)
    });
    const identity = await deriveTransportV2Identity("transport-attachment-batch", canonicalProtocolValue(core));
    const marker: TransportAttachmentBatchMarkerV2 = Object.freeze({
      schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "transport_attachment_batch_marker_v2",
      project_id: project,
      manifest_id: manifest,
      attachment_ids: core.attachment_ids,
      hc1_object_ids: core.hc1_object_ids,
      batch_id: identity.id
    });
    await input.before_visibility?.();
    await this.#failure?.("before_batch_marker");
    const address = batchAddress(manifest);
    const bytes = encodeCanonicalCbor(canonicalProtocolValue(marker));
    const existing = await this.#backend.read(address);
    if (existing && !sameBytes(existing, bytes)) throw new Error("HC-2 transport batch marker collision.");
    if (!existing) await this.#backend.write(address, bytes);
    return marker;
  }

  async readVisibleBatch(manifestId: BundleManifestIdV2, isHc1Visible?: (id: CollaborationObjectId) => Promise<boolean>): Promise<TransportAttachmentBatchMarkerV2 | null> {
    const manifest = parseTransportV2Id("bundle-manifest", manifestId);
    const bytes = await this.#backend.read(batchAddress(manifest));
    if (!bytes) return null;
    const value = expectExactRecord(protocolValueFromCanonical(decodeCanonicalCbor(bytes)), "HC-2 transport batch marker", [
      "schema_version", "record_kind", "project_id", "manifest_id", "attachment_ids", "hc1_object_ids", "batch_id"
    ]);
    expectLiteral(value.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "transport batch schema version");
    expectLiteral(value.record_kind, "transport_attachment_batch_marker_v2", "transport batch kind");
    const project = parseEntityId("project", value.project_id);
    const parsedManifest = parseTransportV2Id("bundle-manifest", value.manifest_id);
    if (parsedManifest !== manifest) throw new Error("HC-2 transport batch marker is stored at the wrong manifest address.");
    const attachmentIds = expectArray(value.attachment_ids, "transport batch attachment IDs").map((entry) => parseTransportV2Id("transport-attachment", entry));
    const hc1Ids = expectArray(value.hc1_object_ids, "transport batch HC-1 IDs").map(parseHc1ObjectId);
    assertSortedUnique(attachmentIds, "transport batch attachment IDs");
    assertSortedUnique(hc1Ids, "transport batch HC-1 IDs");
    const core = Object.freeze({
      schema_version: value.schema_version,
      record_kind: "transport_attachment_batch_core_v2",
      project_id: project,
      manifest_id: parsedManifest,
      attachment_ids: attachmentIds,
      hc1_object_ids: hc1Ids
    });
    const identity = await deriveTransportV2Identity("transport-attachment-batch", canonicalProtocolValue(core));
    const batchId = parseTransportV2Id("transport-attachment-batch", value.batch_id);
    if (identity.id !== batchId) throw new Error("HC-2 transport batch marker identity mismatch.");
    for (const attachmentId of attachmentIds) await this.verifyVisibleAttachment(project, attachmentId);
    if (isHc1Visible) for (const objectId of hc1Ids) if (!(await isHc1Visible(objectId))) throw new Error("HC-1 object named by the combined transport batch is not visible.");
    return Object.freeze({
      schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "transport_attachment_batch_marker_v2",
      project_id: project,
      manifest_id: parsedManifest,
      attachment_ids: Object.freeze(attachmentIds),
      hc1_object_ids: Object.freeze(hc1Ids),
      batch_id: batchId
    });
  }

  private async verifyVisibleAttachment(project: ProjectId, attachmentId: TransportAttachmentIdV2): Promise<void> {
    const matches: Array<Readonly<{ kind: TransportAttachmentPayloadV2["payload_kind"]; data: Uint8Array; marker: Uint8Array }>> = [];
    for (const kind of ["admission_attachment", "epoch_delivery_attachment", "receipt_attachment"] as const) {
      const addresses = attachmentAddresses(kind, attachmentId);
      const [data, marker] = await Promise.all([this.#backend.read(addresses.data), this.#backend.read(addresses.commit)]);
      if (data && marker) matches.push(Object.freeze({ kind, data, marker }));
      else if (data || marker) throw new Error("HC-2 attachment has incomplete data/marker visibility.");
    }
    if (matches.length !== 1) throw new Error("HC-2 attachment is missing or crosses kind namespaces.");
    const match = matches[0];
    const decoded = protocolValueFromCanonical(decodeCanonicalCbor(match.data));
    const record = await this.verifyRecord(parseStoredAttachmentRecord(decoded), project);
    if (record.attachment_id !== attachmentId || record.payload_kind !== match.kind) throw new Error("Visible HC-2 attachment address or kind mismatch.");
    const markerValue = expectExactRecord(protocolValueFromCanonical(decodeCanonicalCbor(match.marker)), "HC-2 attachment marker", [
      "schema_version", "record_kind", "project_id", "payload_kind", "attachment_id", "exact_record_sha256", "marker_id"
    ]);
    const markerCore = Object.freeze({
      schema_version: expectLiteral(markerValue.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "attachment marker version"),
      record_kind: expectLiteral(markerValue.record_kind, "transport_attachment_commit_marker_v2", "attachment marker kind"),
      project_id: parseEntityId("project", markerValue.project_id),
      payload_kind: expectLiteral(markerValue.payload_kind, match.kind, "attachment marker payload kind"),
      attachment_id: parseTransportV2Id("transport-attachment", markerValue.attachment_id),
      exact_record_sha256: parseSha256Digest(expectBytes(markerValue.exact_record_sha256, "attachment record digest"))
    });
    if (markerCore.project_id !== project || markerCore.attachment_id !== attachmentId || !sameBytes(markerCore.exact_record_sha256, await sha256(match.data))) throw new Error("HC-2 attachment marker binding mismatch.");
    const markerIdentity = await deriveTransportV2Identity("transport-attachment-marker", canonicalProtocolValue(markerCore));
    if (markerIdentity.id !== parseTransportV2Id("transport-attachment-marker", markerValue.marker_id)) throw new Error("HC-2 attachment marker identity mismatch.");
  }

  private async verifyRecord(value: TransportAttachmentRecordV2, project: ProjectId): Promise<TransportAttachmentRecordV2> {
    if (value.project_id !== project) throw new Error("HC-2 attachment belongs to another project.");
    const payload = decodeTransportPayloadCoreV2(value.exact_payload_bytes);
    if (payload.payload_kind !== value.payload_kind) throw new Error("HC-2 attachment kind separation failed.");
    const recreated = await this.createAttachment(project, payload);
    if (recreated.payload_id !== value.payload_id || recreated.attachment_id !== value.attachment_id || !sameBytes(recreated.exact_payload_sha256, value.exact_payload_sha256)) throw new Error("HC-2 attachment identity or digest mismatch.");
    return recreated;
  }
}

const root = ".patchmark/patchmark-collaboration/v1/hc2-transport-v2/";
function attachmentAddresses(kind: TransportAttachmentPayloadV2["payload_kind"], id: TransportAttachmentIdV2): Readonly<{ staging: string; data: string; commit: string }> {
  const suffix = transportV2IdSuffix("transport-attachment", id);
  const segment = kind.replace(/_attachment$/, "");
  return Object.freeze({ staging: `${root}staging/${segment}/${suffix}`, data: `${root}data/${segment}/${suffix}`, commit: `${root}commits/${segment}/${suffix}` });
}
function batchAddress(manifest: BundleManifestIdV2): string { return `${root}batches/${transportV2IdSuffix("bundle-manifest", manifest)}`; }
function parseStoredAttachmentRecord(value: unknown): TransportAttachmentRecordV2 {
  const record = expectExactRecord(value, "stored HC-2 transport attachment", [
    "schema_version", "record_kind", "project_id", "payload_id", "attachment_id", "payload_kind", "exact_payload_bytes", "exact_payload_sha256"
  ]);
  if (record.payload_kind !== "admission_attachment" && record.payload_kind !== "epoch_delivery_attachment" && record.payload_kind !== "receipt_attachment") {
    throw new Error("Stored HC-2 attachment has an unsupported kind.");
  }
  return Object.freeze({
    schema_version: expectLiteral(record.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "stored attachment version"),
    record_kind: expectLiteral(record.record_kind, "transport_attachment_record_v2", "stored attachment kind"),
    project_id: parseEntityId("project", record.project_id),
    payload_id: parseTransportV2Id("transport-payload", record.payload_id),
    attachment_id: parseTransportV2Id("transport-attachment", record.attachment_id),
    payload_kind: record.payload_kind,
    exact_payload_bytes: expectBytes(record.exact_payload_bytes, "stored attachment payload bytes"),
    exact_payload_sha256: parseSha256Digest(expectBytes(record.exact_payload_sha256, "stored attachment payload digest"))
  });
}
function parseHc1ObjectId(value: unknown): CollaborationObjectId {
  if (typeof value !== "string") throw new Error("Transport batch HC-1 object ID must be a string.");
  const match = /^pm:([^:]+):v1:/.exec(value);
  if (!match) throw new Error("Transport batch HC-1 object ID has an unsupported namespace.");
  const kind = parseCollaborationObjectKind(match[1]);
  return parseCollaborationObjectId(kind, value);
}
function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) if (values[index - 1] >= values[index]) throw new Error(`${label} must be strictly sorted and unique.`);
}
function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }

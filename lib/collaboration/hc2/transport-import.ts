import type { X25519RecipientKeyPairHandle } from "./crypto-contracts.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectIdByKind,
  type CollaborationObjectKind
} from "../storage.ts";
import { encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import { Hc1CanonicalPortableObjectVerifier } from "./hc1-object-verifier.ts";
import {
  deriveBundleManifestIdentityV2,
  deriveTransportPayloadIdentityV2,
  commonBindingFromTransportBindingV2,
  type AdmissionAttachmentPayloadV2,
  type BundleManifestPayloadV2,
  type EpochDeliveryAttachmentPayloadV2,
  type SignedPlaintextRecordV2,
  type TransportBindingCommonV2,
  type TransportPayloadCoreV2
} from "./transport-v2-contracts.ts";
import type { EncryptedContainerRecordV2 } from "./transport-v2-contracts.ts";
import {
  openEncryptedTransportContainerV2,
  type TransportSignatureV2Provider
} from "./transport-v2-crypto.ts";
import type { RecipientTransportEnvelopeProviderV2 } from "./providers/hpke-v2-provider.ts";
import {
  PortableTransportAttachmentStoreV2,
  type TransportAttachmentPayloadV2
} from "./transport-attachment-store.ts";
import {
  transportStreamKeyFromBindingV2,
  type TransportStreamJournalV2
} from "./transport-stream-store.ts";
import type { BundleManifestIdV2 } from "./transport-v2-identities.ts";

export interface Hc1TransportImportTarget {
  stageAndCommitObject<TKind extends CollaborationObjectKind>(input: Readonly<{
    project_id: TransportBindingCommonV2["project_id"];
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_bytes: Uint8Array;
  }>): Promise<unknown>;
  hasCommittedObject(objectId: CollaborationObjectId): Promise<boolean>;
}

export interface TransportAuthorityVerifierV2 {
  verify(input: Readonly<{
    common_binding: TransportBindingCommonV2;
    payloads: readonly TransportPayloadCoreV2[];
  }>): Promise<
    | Readonly<{ status: "accepted"; epoch_key_available: true }>
    | Readonly<{ status: "rejected"; reason: string }>
  >;
  installAdmissionBeforeVisibility?(input: Readonly<{
    common_binding: TransportBindingCommonV2;
    admission: AdmissionAttachmentPayloadV2;
    delivery: EpochDeliveryAttachmentPayloadV2;
  }>): Promise<void>;
}

export type TransportImportResultV2 =
  | Readonly<{
      status: "imported";
      manifest_id: BundleManifestIdV2;
      hc1_object_ids: readonly CollaborationObjectId[];
      attachment_count: number;
      full_history_verified: boolean | null;
    }>
  | Readonly<{ status: "duplicate"; manifest_id: BundleManifestIdV2 }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authentication_failed"
        | "signature_or_binding_invalid"
        | "manifest_invalid"
        | "authority_rejected"
        | "epoch_key_unavailable"
        | "gap"
        | "fork"
        | "stale_replay"
        | "dependency_missing"
        | "atomic_commit_failed";
      detail?: string;
    }>;

export async function importEncryptedTransportBundleV2(input: Readonly<{
  containers: readonly EncryptedContainerRecordV2[];
  recipient_key_pair: X25519RecipientKeyPairHandle;
  signatures: TransportSignatureV2Provider;
  hpke: RecipientTransportEnvelopeProviderV2;
  authority: TransportAuthorityVerifierV2;
  streams: TransportStreamJournalV2;
  hc1: Hc1TransportImportTarget;
  attachments: PortableTransportAttachmentStoreV2;
}>): Promise<TransportImportResultV2> {
  if (!Array.isArray(input.containers) || input.containers.length === 0) return rejected("manifest_invalid");
  const opened: SignedPlaintextRecordV2[] = [];
  for (let ordinal = 0; ordinal < input.containers.length; ordinal += 1) {
    const container = input.containers[ordinal];
    if (container.core.public_header.chunk_ordinal !== ordinal || container.core.public_header.chunk_count !== input.containers.length) return rejected("manifest_invalid");
    const result = await openEncryptedTransportContainerV2({
      container,
      recipient_key_pair: input.recipient_key_pair,
      signatures: input.signatures,
      hpke: input.hpke
    });
    if (result.status === "rejected") {
      return rejected(result.reason === "authentication_failed" ? "authentication_failed" : "signature_or_binding_invalid");
    }
    opened.push(result.signed);
  }
  let validated: Awaited<ReturnType<typeof validateOpenedPayloadSet>>;
  try {
    validated = await validateOpenedPayloadSet(opened);
  } catch (error) {
    return rejected("manifest_invalid", safeMessage(error));
  }
  const authority = await input.authority.verify({ common_binding: validated.common, payloads: validated.payloads });
  if (authority.status === "rejected") return rejected("authority_rejected", authority.reason);
  if (!authority.epoch_key_available) return rejected("epoch_key_unavailable");
  const stream = transportStreamKeyFromBindingV2(validated.common);
  const continuity = await input.streams.classifyInbound({
    stream,
    manifest_id: validated.manifestId,
    bundle_sequence: validated.common.bundle_sequence,
    previous_manifest_id: validated.common.previous_bundle_manifest_id
  });
  if (continuity === "duplicate") {
    const visible = await input.attachments.readVisibleBatch(validated.manifestId, (id) => input.hc1.hasCommittedObject(id));
    return visible ? Object.freeze({ status: "duplicate", manifest_id: validated.manifestId }) : rejected("atomic_commit_failed", "Stream head exists without the transport batch marker.");
  }
  if (continuity !== "next") return rejected(continuity);
  const verifier = new Hc1CanonicalPortableObjectVerifier(validated.common.project_id);
  const objects = new Map<CollaborationObjectId, Readonly<{ kind: CollaborationObjectKind; id: CollaborationObjectId; bytes: Uint8Array; dependencies: readonly CollaborationObjectId[] }>>();
  try {
    for (const payload of validated.payloads) {
      if (payload.payload_kind !== "hc1_object_chunk") continue;
      assertChunkBinding(payload.chunk_payload_core, validated.common);
      for (const object of payload.chunk_payload_core.object_bytes) {
        const prior = objects.get(object.object_id);
        if (prior && !sameBytes(prior.bytes, object.exact_bytes)) throw new Error("HC-1 object collision across transport chunks.");
        const verified = await verifier.verifyExactObject({
          object_kind: object.object_kind,
          object_id: object.object_id as never,
          exact_bytes: object.exact_bytes
        });
        objects.set(object.object_id, Object.freeze({
          kind: object.object_kind,
          id: object.object_id,
          bytes: Uint8Array.from(object.exact_bytes),
          dependencies: verified.dependency_ids
        }));
      }
    }
    for (const object of objects.values()) {
      for (const dependency of object.dependencies) {
        if (!objects.has(dependency) && !(await input.hc1.hasCommittedObject(dependency))) throw new Error(`Missing HC-1 dependency ${dependency}.`);
      }
    }
  } catch (error) {
    return rejected("dependency_missing", safeMessage(error));
  }
  const attachmentPayloads = validated.payloads.filter(isAttachment);
  try {
    for (const object of [...objects.values()].sort((left, right) => compareAscii(left.id, right.id))) {
      await stageObject(input.hc1, validated.common.project_id, object);
    }
    const attachmentRecords = [];
    for (const payload of attachmentPayloads) attachmentRecords.push(await input.attachments.createAttachment(validated.common.project_id, payload));
    const admission = attachmentPayloads.find((entry): entry is AdmissionAttachmentPayloadV2 => entry.payload_kind === "admission_attachment");
    const delivery = attachmentPayloads.find((entry): entry is EpochDeliveryAttachmentPayloadV2 => entry.payload_kind === "epoch_delivery_attachment");
    await input.attachments.commitBatch({
      project_id: validated.common.project_id,
      manifest_id: validated.manifestId,
      attachments: attachmentRecords,
      hc1_object_ids: Object.freeze([...objects.keys()].sort()),
      before_visibility: admission && delivery && input.authority.installAdmissionBeforeVisibility
        ? () => input.authority.installAdmissionBeforeVisibility!({ common_binding: validated.common, admission, delivery })
        : undefined
    });
    if (!(await input.attachments.readVisibleBatch(validated.manifestId, (id) => input.hc1.hasCommittedObject(id)))) {
      throw new Error("Combined transport batch marker did not reopen as visible.");
    }
    const advanced = await input.streams.commitInbound({
      stream,
      manifest_id: validated.manifestId,
      bundle_sequence: validated.common.bundle_sequence,
      previous_manifest_id: validated.common.previous_bundle_manifest_id
    });
    if (advanced.status === "conflict") throw new Error("Inbound continuity changed before finalization.");
    return Object.freeze({
      status: "imported",
      manifest_id: validated.manifestId,
      hc1_object_ids: Object.freeze([...objects.keys()].sort()),
      attachment_count: attachmentRecords.length,
      full_history_verified: admission ? false : null
    });
  } catch (error) {
    return rejected("atomic_commit_failed", safeMessage(error));
  }
}

async function validateOpenedPayloadSet(records: readonly SignedPlaintextRecordV2[]): Promise<Readonly<{
  manifestId: BundleManifestIdV2;
  common: TransportBindingCommonV2;
  payloads: readonly TransportPayloadCoreV2[];
}>> {
  if (records[0]?.core.payload.payload_kind !== "bundle_manifest") throw new Error("Transport manifest must be the first payload.");
  const manifestPayload = records[0].core.payload as BundleManifestPayloadV2;
  const identity = await deriveBundleManifestIdentityV2(manifestPayload.manifest_core);
  const common = manifestPayload.manifest_core.common_binding;
  if (records.length !== common.payload_count || records.length !== manifestPayload.manifest_core.payload_descriptors.length + 1) throw new Error("Transport payload set is incomplete.");
  if (records[0].core.binding.bundle_manifest_id !== identity.manifest_id) throw new Error("Transport manifest commitment mismatch.");
  const commonBytes = encodeCanonicalCbor(canonicalProtocolValue(common));
  for (let index = 0; index < records.length; index += 1) {
    const binding = records[index].core.binding;
    if (binding.bundle_manifest_id !== identity.manifest_id || binding.payload_ordinal !== index || !sameBytes(commonBytes, encodeCanonicalCbor(canonicalProtocolValue(stripBinding(binding))))) {
      throw new Error("Transport payload binding substitution detected.");
    }
    if (index === 0) continue;
    const descriptor = manifestPayload.manifest_core.payload_descriptors[index - 1];
    const payload = records[index].core.payload;
    if (payload.payload_kind === "bundle_manifest") throw new Error("Transport payload set contains a second manifest.");
    const identified = await deriveTransportPayloadIdentityV2(payload);
    if (descriptor.payload_ordinal !== index || descriptor.payload_kind !== payload.payload_kind || descriptor.payload_id !== identified.payload_id || descriptor.canonical_length !== identified.canonical_length) {
      throw new Error("Transport payload differs from its manifest descriptor.");
    }
  }
  return Object.freeze({ manifestId: identity.manifest_id, common, payloads: Object.freeze(records.map((entry) => entry.core.payload)) });
}

function assertChunkBinding(chunk: import("./envelope.ts").ChunkPayloadCore, common: TransportBindingCommonV2): void {
  if (chunk.project_id !== common.project_id || chunk.sender_person_id !== common.sender_person_id || chunk.sender_device_id !== common.sender_device_id || chunk.recipient_device_id !== common.recipient_device_id || chunk.recipient_key_id !== common.recipient_key_id || chunk.key_epoch_id !== common.key_epoch_id || chunk.accepted_control_head_id !== common.accepted_control_head_id) throw new Error("HC-1 chunk metadata differs from encrypted transport binding.");
}

function stripBinding(binding: SignedPlaintextRecordV2["core"]["binding"]): TransportBindingCommonV2 {
  return commonBindingFromTransportBindingV2(binding);
}

function isAttachment(value: TransportPayloadCoreV2): value is TransportAttachmentPayloadV2 {
  return value.payload_kind === "admission_attachment" || value.payload_kind === "epoch_delivery_attachment" || value.payload_kind === "receipt_attachment";
}

async function stageObject(target: Hc1TransportImportTarget, projectId: TransportBindingCommonV2["project_id"], object: Readonly<{ kind: CollaborationObjectKind; id: CollaborationObjectId; bytes: Uint8Array }>): Promise<void> {
  const kind = parseCollaborationObjectKind(object.kind);
  await target.stageAndCommitObject({ project_id: projectId, object_kind: kind, object_id: parseCollaborationObjectId(kind, object.id), exact_bytes: object.bytes } as never);
}

function rejected(reason: Extract<TransportImportResultV2, { status: "rejected" }>["reason"], detail?: string): Extract<TransportImportResultV2, { status: "rejected" }> { return Object.freeze({ status: "rejected", reason, ...(detail ? { detail } : {}) }); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : "transport_import_failed"; }
function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }

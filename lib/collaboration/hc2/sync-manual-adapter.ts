import { encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import type { X25519RecipientKeyPairHandle } from "./crypto-contracts.ts";
import type { IncrementalSha256, TransportBundleSink, TransportBundleSource } from "./transport-bundle-framing.ts";
import {
  deriveTransportPayloadIdentityV3,
  encodeEncryptedContainerRecordV3,
  type BundleManifestPayloadV3,
  type EncryptedContainerRecordV3,
  type SignedPlaintextRecordV3,
  type TransportPayloadCoreV3
} from "./transport-v3-contracts.ts";
import { openEncryptedTransportContainerV3, type PreparedTransportBundleV3, type TransportSignatureV3Provider } from "./transport-v3-crypto.ts";
import { readCanonicalTransportBundleV3, writeCanonicalTransportBundleV3, type SyncBundleEvidenceV3 } from "./transport-v3-framing.ts";
import type { RecipientTransportEnvelopeProviderV3 } from "./providers/hpke-v3-provider.ts";

export interface ExplicitManualSyncFilePortV3 {
  /** These are called only from explicit export/import invocations. */
  createSink(): Promise<TransportBundleSink>;
  reopenSource(): Promise<TransportBundleSource>;
  createSha256(): IncrementalSha256;
}

export async function exportManualSyncBundleV3(input: Readonly<{
  bundle: PreparedTransportBundleV3;
  port: ExplicitManualSyncFilePortV3;
}>): Promise<SyncBundleEvidenceV3> {
  const expected = input.bundle.containers.map(encodeEncryptedContainerRecordV3);
  const written = await writeCanonicalTransportBundleV3({ containers: input.bundle.containers, sink: await input.port.createSink(), sha256: input.port.createSha256() });
  let ordinal = 0;
  const reopened = await readCanonicalTransportBundleV3({
    source: await input.port.reopenSource(),
    sha256: input.port.createSha256(),
    on_container: async (container, exact) => {
      if (container.container_id !== input.bundle.containers[ordinal]?.container_id || !sameBytes(exact, expected[ordinal])) throw new Error("Reopened V3 manual file differs from the immutable prepared bytes.");
      ordinal += 1;
    }
  });
  if (written.byte_length !== reopened.byte_length || !sameBytes(written.sha256, reopened.sha256)) throw new Error("Reopened V3 manual file evidence differs from the completed write.");
  return reopened;
}

export type OpenedSyncBundleV3 = Readonly<{
  manifest: BundleManifestPayloadV3;
  signed_records: readonly SignedPlaintextRecordV3[];
  payloads: readonly TransportPayloadCoreV3[];
  exact_container_bytes: readonly Uint8Array[];
  file_evidence: SyncBundleEvidenceV3;
}>;

/** Reads, decrypts, authenticates, and verifies the complete manifest before returning any logical payload. */
export async function importManualSyncBundleV3(input: Readonly<{
  port: Pick<ExplicitManualSyncFilePortV3, "reopenSource" | "createSha256">;
  recipient_key_pair: X25519RecipientKeyPairHandle;
  signatures: TransportSignatureV3Provider;
  hpke: RecipientTransportEnvelopeProviderV3;
}>): Promise<OpenedSyncBundleV3> {
  const containers: EncryptedContainerRecordV3[] = [];
  const exactBytes: Uint8Array[] = [];
  const evidence = await readCanonicalTransportBundleV3({
    source: await input.port.reopenSource(),
    sha256: input.port.createSha256(),
    on_container: async (container, exact) => { containers.push(container); exactBytes.push(exact); }
  });
  const records: SignedPlaintextRecordV3[] = [];
  for (const container of containers) {
    const opened = await openEncryptedTransportContainerV3({ container, recipient_key_pair: input.recipient_key_pair, signatures: input.signatures, hpke: input.hpke });
    if (opened.status !== "opened") throw new Error(`V3 bundle container rejected: ${opened.reason}.`);
    records.push(opened.signed);
  }
  const first = records[0];
  if (!first || first.core.payload.payload_kind !== "bundle_manifest") throw new Error("V3 bundle manifest must be the first encrypted payload.");
  const manifest = first.core.payload;
  if (manifest.manifest_core.payload_descriptors.length !== records.length - 1) throw new Error("V3 manifest does not describe the complete bundle.");
  for (let index = 1; index < records.length; index += 1) {
    const signed = records[index];
    const descriptor = manifest.manifest_core.payload_descriptors[index - 1];
    if (signed.core.binding.bundle_manifest_id !== first.core.binding.bundle_manifest_id || signed.core.binding.payload_ordinal !== index || descriptor.payload_kind !== signed.core.payload.payload_kind) throw new Error("V3 bundle payload binding differs from its manifest.");
    const identified = await deriveTransportPayloadIdentityV3(signed.core.payload as Exclude<TransportPayloadCoreV3, BundleManifestPayloadV3>);
    if (identified.payload_id !== descriptor.payload_id || identified.canonical_length !== descriptor.canonical_length) throw new Error("V3 bundle payload commitment differs from its manifest.");
  }
  return Object.freeze({ manifest, signed_records: Object.freeze(records), payloads: Object.freeze(records.map((entry) => entry.core.payload)), exact_container_bytes: Object.freeze(exactBytes.map((entry) => Uint8Array.from(entry))), file_evidence: evidence });
}

export interface AtomicSyncImportBackendV3<TResult> {
  stageAndVerify(input: Readonly<{ bundle: OpenedSyncBundleV3 }>): Promise<Readonly<{ status: "staged"; token: string }> | Readonly<{ status: "rejected"; reason: string }>>;
  verifyCombined(input: Readonly<{ token: string }>): Promise<boolean>;
  commitBatchMarkerLast(input: Readonly<{ token: string }>): Promise<void>;
  reopenAndReconstruct(input: Readonly<{ token: string }>): Promise<TResult>;
  discardStaging(input: Readonly<{ token: string }>): Promise<void>;
}

/** The injected backend uses the existing HC-1/Slice-6 validators and batch-marker-last path. */
export async function atomicImportOpenedSyncBundleV3<TResult>(input: Readonly<{
  bundle: OpenedSyncBundleV3;
  backend: AtomicSyncImportBackendV3<TResult>;
  finalize_session_and_stream_cas: (result: TResult) => Promise<boolean>;
}>): Promise<Readonly<{ status: "imported"; result: TResult }> | Readonly<{ status: "rejected" | "conflict"; reason: string }>> {
  const staged = await input.backend.stageAndVerify({ bundle: input.bundle });
  if (staged.status === "rejected") return Object.freeze({ status: "rejected", reason: staged.reason });
  try {
    if (!(await input.backend.verifyCombined({ token: staged.token }))) return Object.freeze({ status: "rejected", reason: "combined_dependency_or_authority_verification_failed" });
    await input.backend.commitBatchMarkerLast({ token: staged.token });
    const result = await input.backend.reopenAndReconstruct({ token: staged.token });
    if (!(await input.finalize_session_and_stream_cas(result))) return Object.freeze({ status: "conflict", reason: "session_or_stream_cas_failed_after_durable_reopen" });
    return Object.freeze({ status: "imported", result });
  } finally { await input.backend.discardStaging({ token: staged.token }); }
}

export function encryptedBundlePrivacyScanV3(containers: readonly EncryptedContainerRecordV3[], forbiddenUtf8: readonly string[]): void {
  const bytes = encodeCanonicalCbor(canonicalProtocolValue(Object.freeze(containers)));
  const text = new TextDecoder().decode(bytes);
  for (const forbidden of forbiddenUtf8) if (forbidden && text.includes(forbidden)) throw new Error("V3 outer framing exposes a forbidden synchronization identifier.");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]); }

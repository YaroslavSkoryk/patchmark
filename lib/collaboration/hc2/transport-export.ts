import {
  encodeEncryptedContainerRecordV2
} from "./transport-v2-contracts.ts";
import type { PreparedTransportBundleV2 } from "./transport-v2-crypto.ts";
import {
  readCanonicalTransportBundleV2,
  writeCanonicalTransportBundleV2,
  type IncrementalSha256,
  type TransportBundleSink,
  type TransportBundleSource
} from "./transport-bundle-framing.ts";
import {
  transportStreamKeyFromBindingV2,
  type TransportStreamJournalV2
} from "./transport-stream-store.ts";

export type TransportExportResultV2 =
  | Readonly<{
      status: "completed" | "resumed_completed";
      manifest_id: PreparedTransportBundleV2["manifest_id"];
      byte_length: bigint;
      sha256: Uint8Array;
      container_count: number;
    }>
  | Readonly<{ status: "conflict"; reason: string }>;

/**
 * Writes a temp output incrementally, closes it, reopens and verifies exact
 * length/digest/container identities, then and only then advances the stream.
 */
export async function exportEncryptedTransportBundleV2(input: Readonly<{
  bundle: PreparedTransportBundleV2;
  streams: TransportStreamJournalV2;
  create_sink: (mode: "fresh" | "retry") => Promise<TransportBundleSink>;
  reopen_source: () => Promise<TransportBundleSource>;
  create_sha256: () => IncrementalSha256;
}>): Promise<TransportExportResultV2> {
  const first = input.bundle.payloads[0];
  if (!first || first.payload_kind !== "bundle_manifest") return Object.freeze({ status: "conflict", reason: "bundle_manifest_missing" });
  const common = first.manifest_core.common_binding;
  const stream = transportStreamKeyFromBindingV2(common);
  const reserved = await input.streams.reserveOutbound({
    stream,
    manifest_id: input.bundle.manifest_id,
    bundle_sequence: common.bundle_sequence,
    previous_manifest_id: common.previous_bundle_manifest_id
  });
  if (reserved.status === "conflict") return Object.freeze({ status: "conflict", reason: "stream_compare_and_swap_failed" });
  const retry = reserved.status === "resumed";
  if (retry && reserved.plan.status === "completed" && reserved.plan.file_evidence) {
    return Object.freeze({
      status: "resumed_completed",
      manifest_id: input.bundle.manifest_id,
      byte_length: reserved.plan.file_evidence.byte_length,
      sha256: Uint8Array.from(reserved.plan.file_evidence.sha256),
      container_count: reserved.plan.file_evidence.container_ids.length
    });
  }
  for (let ordinal = 0; ordinal < input.bundle.containers.length; ordinal += 1) {
    const stored = await input.streams.appendOutboundContainer({
      stream,
      manifest_id: input.bundle.manifest_id,
      ordinal,
      exact_bytes: encodeEncryptedContainerRecordV2(input.bundle.containers[ordinal])
    });
    if (stored.status === "collision") return Object.freeze({ status: "conflict", reason: "journaled_container_collision" });
  }
  const sink = await input.create_sink(retry ? "retry" : "fresh");
  const written = await writeCanonicalTransportBundleV2({
    containers: input.bundle.containers,
    sink,
    sha256: input.create_sha256()
  });
  const plan = await input.streams.readOutbound(stream, input.bundle.manifest_id);
  if (!plan || plan.exact_container_bytes.length !== input.bundle.containers.length) return Object.freeze({ status: "conflict", reason: "journal_incomplete" });
  let reopenedOrdinal = 0;
  const reopened = await readCanonicalTransportBundleV2({
    source: await input.reopen_source(),
    sha256: input.create_sha256(),
    on_container: async (container, exactBytes) => {
      const expectedBytes = plan.exact_container_bytes[reopenedOrdinal];
      const expectedId = input.bundle.containers[reopenedOrdinal]?.container_id;
      if (!expectedBytes || expectedId !== container.container_id || !sameBytes(expectedBytes, exactBytes)) throw new Error("Reopened transport file differs from the immutable journal.");
      reopenedOrdinal += 1;
    }
  });
  if (written.byte_length !== reopened.byte_length || !sameBytes(written.sha256, reopened.sha256) || !sameStrings(written.container_ids, reopened.container_ids)) {
    return Object.freeze({ status: "conflict", reason: "reopen_verification_failed" });
  }
  await input.streams.markOutboundReopenedVerified({
    stream,
    manifest_id: input.bundle.manifest_id,
    evidence: Object.freeze({ byte_length: reopened.byte_length, sha256: reopened.sha256, container_ids: reopened.container_ids })
  });
  const completed = await input.streams.completeOutbound({ stream, manifest_id: input.bundle.manifest_id });
  if (completed.status === "conflict") return Object.freeze({ status: "conflict", reason: "stream_finalization_failed" });
  return Object.freeze({
    status: retry ? "resumed_completed" : "completed",
    manifest_id: input.bundle.manifest_id,
    byte_length: reopened.byte_length,
    sha256: Uint8Array.from(reopened.sha256),
    container_count: reopened.container_count
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

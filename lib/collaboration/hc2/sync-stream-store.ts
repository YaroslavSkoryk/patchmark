import type { UInt64 } from "../validation.ts";
import type { BundleManifestIdV3, SyncSessionIdV3, TransportStreamIdV3 } from "./sync-v3-identities.ts";

export type SyncTransportHeadV3 = Readonly<{
  stream_id: TransportStreamIdV3;
  stream_generation: UInt64;
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  bundle_sequence: UInt64;
  manifest_id: BundleManifestIdV3;
}>;

export type SyncContinuityResultV3 =
  | Readonly<{ status: "next" }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "retryable_gap" }>
  | Readonly<{ status: "stream_fork" }>
  | Readonly<{ status: "unknown_session_generation" }>
  | Readonly<{ status: "abandoned_session" }>;

/** Pure continuity classifier. It never chooses a fork by arrival order. */
export function classifySyncTransportContinuityV3(input: Readonly<{
  head: SyncTransportHeadV3 | null;
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  stream_id: TransportStreamIdV3;
  stream_generation: UInt64;
  bundle_sequence: UInt64;
  previous_manifest_id: BundleManifestIdV3 | null;
  manifest_id: BundleManifestIdV3;
  session_status: "active" | "abandoned";
}>): SyncContinuityResultV3 {
  if (input.session_status === "abandoned") return Object.freeze({ status: "abandoned_session" });
  const head = input.head;
  if (head && (head.session_id !== input.session_id || head.session_generation !== input.session_generation)) return Object.freeze({ status: "unknown_session_generation" });
  if (head && (head.stream_id !== input.stream_id || head.stream_generation !== input.stream_generation)) return Object.freeze({ status: "stream_fork" });
  if (!head) return input.bundle_sequence === BigInt(0) && input.previous_manifest_id === null
    ? Object.freeze({ status: "next" })
    : Object.freeze({ status: "retryable_gap" });
  if (input.bundle_sequence === head.bundle_sequence) return input.manifest_id === head.manifest_id
    ? Object.freeze({ status: "duplicate" })
    : Object.freeze({ status: "stream_fork" });
  if (input.bundle_sequence > head.bundle_sequence + BigInt(1)) return Object.freeze({ status: "retryable_gap" });
  if (input.bundle_sequence !== head.bundle_sequence + BigInt(1) || input.previous_manifest_id !== head.manifest_id) return Object.freeze({ status: "stream_fork" });
  return Object.freeze({ status: "next" });
}

export class InMemorySyncTransportJournalV3 {
  readonly #heads = new Map<string, SyncTransportHeadV3>();

  read(streamId: TransportStreamIdV3, streamGeneration: UInt64): SyncTransportHeadV3 | null {
    return this.#heads.get(`${streamId}:${streamGeneration}`) ?? null;
  }

  commit(input: Omit<Parameters<typeof classifySyncTransportContinuityV3>[0], "head">): SyncContinuityResultV3 {
    const key = `${input.stream_id}:${input.stream_generation}`;
    const result = classifySyncTransportContinuityV3({ ...input, head: this.#heads.get(key) ?? null });
    if (result.status === "next") this.#heads.set(key, Object.freeze({ stream_id: input.stream_id, stream_generation: input.stream_generation, session_id: input.session_id, session_generation: input.session_generation, bundle_sequence: input.bundle_sequence, manifest_id: input.manifest_id }));
    return result;
  }
}

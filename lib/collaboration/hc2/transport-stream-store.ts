import type { Sha256Digest } from "../sha256.ts";
import type { EncryptedContainerIdV2, BundleManifestIdV2, TransportStreamIdV2 } from "./transport-v2-identities.ts";
import type { TransportBindingCommonV2 } from "./transport-v2-contracts.ts";

export type TransportStreamKeyV2 = Readonly<{
  project_id: TransportBindingCommonV2["project_id"];
  purpose: TransportBindingCommonV2["purpose"];
  sender_person_id: TransportBindingCommonV2["sender_person_id"];
  sender_membership_id: TransportBindingCommonV2["sender_membership_id"];
  sender_device_id: TransportBindingCommonV2["sender_device_id"];
  sender_signing_key_id: TransportBindingCommonV2["sender_signing_key_id"];
  recipient_person_id: TransportBindingCommonV2["recipient_person_id"];
  recipient_membership_id: TransportBindingCommonV2["recipient_membership_id"];
  recipient_device_id: TransportBindingCommonV2["recipient_device_id"];
  recipient_key_id: TransportBindingCommonV2["recipient_key_id"];
  stream_id: TransportStreamIdV2;
  stream_generation: TransportBindingCommonV2["stream_generation"];
}>;

export type TransportFileEvidenceV2 = Readonly<{
  byte_length: bigint;
  sha256: Sha256Digest;
  container_ids: readonly EncryptedContainerIdV2[];
}>;

export type OutboundTransportPlanV2 = Readonly<{
  stream: TransportStreamKeyV2;
  manifest_id: BundleManifestIdV2;
  bundle_sequence: bigint;
  previous_manifest_id: BundleManifestIdV2 | null;
  status: "planned" | "writing" | "reopened_verified" | "completed";
  exact_container_bytes: readonly Uint8Array[];
  file_evidence: TransportFileEvidenceV2 | null;
}>;

export type TransportHeadV2 = Readonly<{
  bundle_sequence: bigint;
  manifest_id: BundleManifestIdV2;
}>;

export interface TransportStreamJournalV2 {
  reserveOutbound(input: Readonly<{
    stream: TransportStreamKeyV2;
    manifest_id: BundleManifestIdV2;
    bundle_sequence: bigint;
    previous_manifest_id: BundleManifestIdV2 | null;
  }>): Promise<Readonly<{ status: "reserved" | "resumed"; plan: OutboundTransportPlanV2 }> | Readonly<{ status: "conflict" }>>;
  appendOutboundContainer(input: Readonly<{
    stream: TransportStreamKeyV2;
    manifest_id: BundleManifestIdV2;
    ordinal: number;
    exact_bytes: Uint8Array;
  }>): Promise<Readonly<{ status: "stored" | "already_present" }> | Readonly<{ status: "collision" }>>;
  markOutboundReopenedVerified(input: Readonly<{
    stream: TransportStreamKeyV2;
    manifest_id: BundleManifestIdV2;
    evidence: TransportFileEvidenceV2;
  }>): Promise<void>;
  completeOutbound(input: Readonly<{ stream: TransportStreamKeyV2; manifest_id: BundleManifestIdV2 }>): Promise<Readonly<{ status: "completed" | "already_completed" }> | Readonly<{ status: "conflict" }>>;
  readOutbound(stream: TransportStreamKeyV2, manifestId: BundleManifestIdV2): Promise<OutboundTransportPlanV2 | null>;
  classifyInbound(input: Readonly<{
    stream: TransportStreamKeyV2;
    manifest_id: BundleManifestIdV2;
    bundle_sequence: bigint;
    previous_manifest_id: BundleManifestIdV2 | null;
  }>): Promise<"next" | "duplicate" | "stale_replay" | "gap" | "fork">;
  commitInbound(input: Readonly<{
    stream: TransportStreamKeyV2;
    manifest_id: BundleManifestIdV2;
    bundle_sequence: bigint;
    previous_manifest_id: BundleManifestIdV2 | null;
  }>): Promise<Readonly<{ status: "committed" | "duplicate" }> | Readonly<{ status: "conflict" }>>;
}

/**
 * Deterministic reference journal. Browser persistence adapters implement the
 * same compare-and-swap contract; this implementation drives fault tests and
 * keeps all byte ownership explicit.
 */
export class InMemoryTransportStreamJournalV2 implements TransportStreamJournalV2 {
  readonly #outbound = new Map<string, OutboundTransportPlanV2>();
  readonly #outboundHeads = new Map<string, TransportHeadV2>();
  readonly #outboundReservations = new Map<string, BundleManifestIdV2>();
  readonly #inboundHeads = new Map<string, TransportHeadV2>();

  async reserveOutbound(input: Parameters<TransportStreamJournalV2["reserveOutbound"]>[0]): ReturnType<TransportStreamJournalV2["reserveOutbound"]> {
    assertPosition(input.bundle_sequence, input.previous_manifest_id);
    const key = planKey(input.stream, input.manifest_id);
    const headKey = streamKey(input.stream);
    const existing = this.#outbound.get(key);
    if (existing) {
      if (existing.bundle_sequence !== input.bundle_sequence || existing.previous_manifest_id !== input.previous_manifest_id) return Object.freeze({ status: "conflict" });
      return Object.freeze({ status: "resumed", plan: copyPlan(existing) });
    }
    const reservation = this.#outboundReservations.get(headKey);
    if (reservation !== undefined && reservation !== input.manifest_id) return Object.freeze({ status: "conflict" });
    if (!headAccepts(this.#outboundHeads.get(headKey) ?? null, input.bundle_sequence, input.previous_manifest_id)) {
      return Object.freeze({ status: "conflict" });
    }
    const plan: OutboundTransportPlanV2 = Object.freeze({
      stream: Object.freeze({ ...input.stream }),
      manifest_id: input.manifest_id,
      bundle_sequence: input.bundle_sequence,
      previous_manifest_id: input.previous_manifest_id,
      status: "planned",
      exact_container_bytes: Object.freeze([]),
      file_evidence: null
    });
    this.#outbound.set(key, plan);
    this.#outboundReservations.set(headKey, input.manifest_id);
    return Object.freeze({ status: "reserved", plan: copyPlan(plan) });
  }

  async appendOutboundContainer(input: Parameters<TransportStreamJournalV2["appendOutboundContainer"]>[0]): ReturnType<TransportStreamJournalV2["appendOutboundContainer"]> {
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || !(input.exact_bytes instanceof Uint8Array) || input.exact_bytes.length === 0) throw new Error("Outbound container journal append is malformed.");
    const key = planKey(input.stream, input.manifest_id);
    const plan = this.#outbound.get(key);
    if (!plan || plan.status === "completed" || input.ordinal > plan.exact_container_bytes.length) return Object.freeze({ status: "collision" });
    const prior = plan.exact_container_bytes[input.ordinal];
    if (prior) return Object.freeze({ status: sameBytes(prior, input.exact_bytes) ? "already_present" : "collision" });
    const bytes = [...plan.exact_container_bytes, Uint8Array.from(input.exact_bytes)];
    this.#outbound.set(key, Object.freeze({ ...plan, status: "writing", exact_container_bytes: Object.freeze(bytes) }));
    return Object.freeze({ status: "stored" });
  }

  async markOutboundReopenedVerified(input: Parameters<TransportStreamJournalV2["markOutboundReopenedVerified"]>[0]): Promise<void> {
    const key = planKey(input.stream, input.manifest_id);
    const plan = this.#outbound.get(key);
    if (!plan || plan.status === "completed" || plan.exact_container_bytes.length !== input.evidence.container_ids.length) throw new Error("Outbound file cannot be verified before every immutable container is journaled.");
    this.#outbound.set(key, Object.freeze({
      ...plan,
      status: "reopened_verified",
      file_evidence: copyEvidence(input.evidence)
    }));
  }

  async completeOutbound(input: Parameters<TransportStreamJournalV2["completeOutbound"]>[0]): ReturnType<TransportStreamJournalV2["completeOutbound"]> {
    const key = planKey(input.stream, input.manifest_id);
    const plan = this.#outbound.get(key);
    if (!plan) return Object.freeze({ status: "conflict" });
    if (plan.status === "completed") return Object.freeze({ status: "already_completed" });
    if (plan.status !== "reopened_verified" || !plan.file_evidence) return Object.freeze({ status: "conflict" });
    const headKey = streamKey(input.stream);
    if (!headAccepts(this.#outboundHeads.get(headKey) ?? null, plan.bundle_sequence, plan.previous_manifest_id)) return Object.freeze({ status: "conflict" });
    this.#outboundHeads.set(headKey, Object.freeze({ bundle_sequence: plan.bundle_sequence, manifest_id: plan.manifest_id }));
    this.#outboundReservations.delete(headKey);
    this.#outbound.set(key, Object.freeze({ ...plan, status: "completed" }));
    return Object.freeze({ status: "completed" });
  }

  async readOutbound(stream: TransportStreamKeyV2, manifestId: BundleManifestIdV2): Promise<OutboundTransportPlanV2 | null> {
    const value = this.#outbound.get(planKey(stream, manifestId));
    return value ? copyPlan(value) : null;
  }

  async classifyInbound(input: Parameters<TransportStreamJournalV2["classifyInbound"]>[0]): ReturnType<TransportStreamJournalV2["classifyInbound"]> {
    assertPosition(input.bundle_sequence, input.previous_manifest_id);
    return classify(this.#inboundHeads.get(streamKey(input.stream)) ?? null, input.bundle_sequence, input.previous_manifest_id, input.manifest_id);
  }

  async commitInbound(input: Parameters<TransportStreamJournalV2["commitInbound"]>[0]): ReturnType<TransportStreamJournalV2["commitInbound"]> {
    const key = streamKey(input.stream);
    const classification = classify(this.#inboundHeads.get(key) ?? null, input.bundle_sequence, input.previous_manifest_id, input.manifest_id);
    if (classification === "duplicate") return Object.freeze({ status: "duplicate" });
    if (classification !== "next") return Object.freeze({ status: "conflict" });
    this.#inboundHeads.set(key, Object.freeze({ bundle_sequence: input.bundle_sequence, manifest_id: input.manifest_id }));
    return Object.freeze({ status: "committed" });
  }
}

/** Durable browser CAS journal. All head checks and advances share one IDB transaction. */
export class IndexedDbTransportStreamJournalV2 implements TransportStreamJournalV2 {
  readonly #indexedDb: IDBFactory;
  readonly #databaseName: string;
  #database: IDBDatabase | null = null;

  constructor(input: Readonly<{ indexed_db: IDBFactory; database_name: string }>) {
    if (!input?.indexed_db || typeof input.database_name !== "string" || input.database_name.length === 0) throw new Error("IndexedDB transport journal requires an injected factory and database name.");
    this.#indexedDb = input.indexed_db;
    this.#databaseName = input.database_name;
  }

  async open(): Promise<void> {
    if (this.#database) return;
    const request = this.#indexedDb.open(this.#databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of ["outbound_plans", "outbound_heads", "outbound_reservations", "inbound_heads"]) if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
    };
    this.#database = await idbRequest(request);
  }

  close(): void { this.#database?.close(); this.#database = null; }

  async deleteDatabase(): Promise<void> {
    this.close();
    await idbRequest(this.#indexedDb.deleteDatabase(this.#databaseName));
  }

  async reserveOutbound(input: Parameters<TransportStreamJournalV2["reserveOutbound"]>[0]): ReturnType<TransportStreamJournalV2["reserveOutbound"]> {
    assertPosition(input.bundle_sequence, input.previous_manifest_id);
    const transaction = this.#transaction(["outbound_plans", "outbound_heads", "outbound_reservations"], "readwrite");
    const plans = transaction.objectStore("outbound_plans");
    const heads = transaction.objectStore("outbound_heads");
    const reservations = transaction.objectStore("outbound_reservations");
    const key = planKey(input.stream, input.manifest_id);
    const headKey = streamKey(input.stream);
    const existing = await idbRequest<OutboundTransportPlanV2 | undefined>(plans.get(key));
    if (existing) {
      await idbDone(transaction);
      return existing.bundle_sequence === input.bundle_sequence && existing.previous_manifest_id === input.previous_manifest_id
        ? Object.freeze({ status: "resumed", plan: copyPlan(existing) })
        : Object.freeze({ status: "conflict" });
    }
    const reservation = await idbRequest<BundleManifestIdV2 | undefined>(reservations.get(headKey));
    if (reservation !== undefined && reservation !== input.manifest_id) {
      transaction.abort(); await ignoreAbort(transaction); return Object.freeze({ status: "conflict" });
    }
    const head = await idbRequest<TransportHeadV2 | undefined>(heads.get(headKey));
    if (!headAccepts(head ?? null, input.bundle_sequence, input.previous_manifest_id)) {
      transaction.abort();
      await ignoreAbort(transaction);
      return Object.freeze({ status: "conflict" });
    }
    const plan: OutboundTransportPlanV2 = Object.freeze({ stream: Object.freeze({ ...input.stream }), manifest_id: input.manifest_id,
      bundle_sequence: input.bundle_sequence, previous_manifest_id: input.previous_manifest_id, status: "planned",
      exact_container_bytes: Object.freeze([]), file_evidence: null });
    plans.put(plan, key);
    reservations.put(input.manifest_id, headKey);
    await idbDone(transaction);
    return Object.freeze({ status: "reserved", plan: copyPlan(plan) });
  }

  async appendOutboundContainer(input: Parameters<TransportStreamJournalV2["appendOutboundContainer"]>[0]): ReturnType<TransportStreamJournalV2["appendOutboundContainer"]> {
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || !(input.exact_bytes instanceof Uint8Array) || input.exact_bytes.length === 0) throw new Error("Outbound container journal append is malformed.");
    const transaction = this.#transaction(["outbound_plans"], "readwrite");
    const store = transaction.objectStore("outbound_plans");
    const key = planKey(input.stream, input.manifest_id);
    const plan = await idbRequest<OutboundTransportPlanV2 | undefined>(store.get(key));
    if (!plan || plan.status === "completed" || input.ordinal > plan.exact_container_bytes.length) {
      transaction.abort(); await ignoreAbort(transaction); return Object.freeze({ status: "collision" });
    }
    const prior = plan.exact_container_bytes[input.ordinal];
    if (prior) {
      await idbDone(transaction);
      return Object.freeze({ status: sameBytes(prior, input.exact_bytes) ? "already_present" : "collision" });
    }
    store.put({ ...plan, status: "writing", exact_container_bytes: [...plan.exact_container_bytes, Uint8Array.from(input.exact_bytes)] }, key);
    await idbDone(transaction);
    return Object.freeze({ status: "stored" });
  }

  async markOutboundReopenedVerified(input: Parameters<TransportStreamJournalV2["markOutboundReopenedVerified"]>[0]): Promise<void> {
    const transaction = this.#transaction(["outbound_plans"], "readwrite");
    const store = transaction.objectStore("outbound_plans");
    const key = planKey(input.stream, input.manifest_id);
    const plan = await idbRequest<OutboundTransportPlanV2 | undefined>(store.get(key));
    if (!plan || plan.status === "completed" || plan.exact_container_bytes.length !== input.evidence.container_ids.length) {
      transaction.abort(); await ignoreAbort(transaction); throw new Error("Outbound file cannot be verified before every immutable container is journaled.");
    }
    store.put({ ...plan, status: "reopened_verified", file_evidence: copyEvidence(input.evidence) }, key);
    await idbDone(transaction);
  }

  async completeOutbound(input: Parameters<TransportStreamJournalV2["completeOutbound"]>[0]): ReturnType<TransportStreamJournalV2["completeOutbound"]> {
    const transaction = this.#transaction(["outbound_plans", "outbound_heads", "outbound_reservations"], "readwrite");
    const plans = transaction.objectStore("outbound_plans");
    const heads = transaction.objectStore("outbound_heads");
    const reservations = transaction.objectStore("outbound_reservations");
    const key = planKey(input.stream, input.manifest_id);
    const plan = await idbRequest<OutboundTransportPlanV2 | undefined>(plans.get(key));
    if (!plan) { transaction.abort(); await ignoreAbort(transaction); return Object.freeze({ status: "conflict" }); }
    if (plan.status === "completed") { await idbDone(transaction); return Object.freeze({ status: "already_completed" }); }
    const headKey = streamKey(input.stream);
    const head = await idbRequest<TransportHeadV2 | undefined>(heads.get(headKey));
    if (plan.status !== "reopened_verified" || !plan.file_evidence || !headAccepts(head ?? null, plan.bundle_sequence, plan.previous_manifest_id)) {
      transaction.abort(); await ignoreAbort(transaction); return Object.freeze({ status: "conflict" });
    }
    heads.put({ bundle_sequence: plan.bundle_sequence, manifest_id: plan.manifest_id }, headKey);
    reservations.delete(headKey);
    plans.put({ ...plan, status: "completed" }, key);
    await idbDone(transaction);
    return Object.freeze({ status: "completed" });
  }

  async readOutbound(stream: TransportStreamKeyV2, manifestId: BundleManifestIdV2): Promise<OutboundTransportPlanV2 | null> {
    const transaction = this.#transaction(["outbound_plans"], "readonly");
    const plan = await idbRequest<OutboundTransportPlanV2 | undefined>(transaction.objectStore("outbound_plans").get(planKey(stream, manifestId)));
    await idbDone(transaction);
    return plan ? copyPlan(plan) : null;
  }

  async classifyInbound(input: Parameters<TransportStreamJournalV2["classifyInbound"]>[0]): ReturnType<TransportStreamJournalV2["classifyInbound"]> {
    assertPosition(input.bundle_sequence, input.previous_manifest_id);
    const transaction = this.#transaction(["inbound_heads"], "readonly");
    const head = await idbRequest<TransportHeadV2 | undefined>(transaction.objectStore("inbound_heads").get(streamKey(input.stream)));
    await idbDone(transaction);
    return classify(head ?? null, input.bundle_sequence, input.previous_manifest_id, input.manifest_id);
  }

  async commitInbound(input: Parameters<TransportStreamJournalV2["commitInbound"]>[0]): ReturnType<TransportStreamJournalV2["commitInbound"]> {
    const transaction = this.#transaction(["inbound_heads"], "readwrite");
    const store = transaction.objectStore("inbound_heads");
    const key = streamKey(input.stream);
    const head = await idbRequest<TransportHeadV2 | undefined>(store.get(key));
    const result = classify(head ?? null, input.bundle_sequence, input.previous_manifest_id, input.manifest_id);
    if (result === "duplicate") { await idbDone(transaction); return Object.freeze({ status: "duplicate" }); }
    if (result !== "next") { transaction.abort(); await ignoreAbort(transaction); return Object.freeze({ status: "conflict" }); }
    store.put({ bundle_sequence: input.bundle_sequence, manifest_id: input.manifest_id }, key);
    await idbDone(transaction);
    return Object.freeze({ status: "committed" });
  }

  #transaction(stores: string[], mode: IDBTransactionMode): IDBTransaction {
    if (!this.#database) throw new Error("IndexedDB transport journal is not open.");
    return this.#database.transaction(stores, mode);
  }
}

export function transportStreamKeyFromBindingV2(binding: TransportBindingCommonV2): TransportStreamKeyV2 {
  return Object.freeze({
    project_id: binding.project_id,
    purpose: binding.purpose,
    sender_person_id: binding.sender_person_id,
    sender_membership_id: binding.sender_membership_id,
    sender_device_id: binding.sender_device_id,
    sender_signing_key_id: binding.sender_signing_key_id,
    recipient_person_id: binding.recipient_person_id,
    recipient_membership_id: binding.recipient_membership_id,
    recipient_device_id: binding.recipient_device_id,
    recipient_key_id: binding.recipient_key_id,
    stream_id: binding.stream_id,
    stream_generation: binding.stream_generation
  });
}

function classify(head: TransportHeadV2 | null, sequence: bigint, previous: BundleManifestIdV2 | null, manifest: BundleManifestIdV2): "next" | "duplicate" | "stale_replay" | "gap" | "fork" {
  if (head === null) return sequence === BigInt(0) && previous === null ? "next" : "gap";
  if (sequence === head.bundle_sequence && manifest === head.manifest_id) return "duplicate";
  if (sequence <= head.bundle_sequence) return "stale_replay";
  if (sequence > head.bundle_sequence + BigInt(1)) return "gap";
  return previous === head.manifest_id ? "next" : "fork";
}

function headAccepts(head: TransportHeadV2 | null, sequence: bigint, previous: BundleManifestIdV2 | null): boolean {
  return head === null
    ? sequence === BigInt(0) && previous === null
    : sequence === head.bundle_sequence + BigInt(1) && previous === head.manifest_id;
}

function assertPosition(sequence: bigint, previous: BundleManifestIdV2 | null): void {
  if (typeof sequence !== "bigint" || sequence < BigInt(0) || (sequence === BigInt(0)) !== (previous === null)) throw new Error("Transport stream position is malformed.");
}

function streamKey(value: TransportStreamKeyV2): string {
  return [value.project_id, value.purpose, value.sender_person_id, value.sender_membership_id, value.sender_device_id, value.sender_signing_key_id, value.recipient_person_id, value.recipient_membership_id ?? "candidate", value.recipient_device_id, value.recipient_key_id, value.stream_id, value.stream_generation.toString()].join("\u0000");
}
function planKey(stream: TransportStreamKeyV2, manifest: BundleManifestIdV2): string { return `${streamKey(stream)}\u0000${manifest}`; }
function copyPlan(value: OutboundTransportPlanV2): OutboundTransportPlanV2 { return Object.freeze({ ...value, stream: Object.freeze({ ...value.stream }), exact_container_bytes: Object.freeze(value.exact_container_bytes.map((entry) => Uint8Array.from(entry))), file_evidence: value.file_evidence ? copyEvidence(value.file_evidence) : null }); }
function copyEvidence(value: TransportFileEvidenceV2): TransportFileEvidenceV2 { return Object.freeze({ byte_length: value.byte_length, sha256: Uint8Array.from(value.sha256) as Sha256Digest, container_ids: Object.freeze([...value.container_ids]) }); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }

function idbRequest<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB transport request failed.")); }); }
function idbDone(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transport transaction aborted.")); transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transport transaction failed.")); }); }
async function ignoreAbort(transaction: IDBTransaction): Promise<void> { try { await idbDone(transaction); } catch { /* expected explicit CAS abort */ } }

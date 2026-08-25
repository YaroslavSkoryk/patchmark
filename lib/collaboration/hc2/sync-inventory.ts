import { canonicalProtocolValue } from "../canonical-protocol.ts";
import { parseEntityId, type ProjectId } from "../identities.ts";
import { parseSha256Digest, sha256 } from "../sha256.ts";
import type { UInt64 } from "../validation.ts";
import {
  encodeSyncProtocolValueV3,
  identifyInventoryPageV3,
  identifyInventorySnapshotV3,
  inventoryDescriptorKey,
  parseInventoryDescriptorV3,
  parseInventoryPageCoreV3,
  parseInventorySnapshotCoreV3,
  type InventoryDescriptorV3,
  type InventoryPageV3,
  type InventorySnapshotCoreV3,
  type SyncInventoryObjectKind,
  type SyncStorageFamily,
  type VerifiedInventorySnapshotV3
} from "./sync-contracts.ts";
import {
  deriveSyncV3Identity,
  type InventoryRootIdV3,
  type InventorySnapshotIdV3,
  type SyncSessionIdV3
} from "./sync-v3-identities.ts";
import { HC2_SYNC_SCHEMA_VERSION, hc2SyncInvocationLimits } from "./sync-v3-versions.ts";

export type PortableInventoryCandidateV3 = Readonly<{
  storage_family: SyncStorageFamily;
  object_kind: SyncInventoryObjectKind;
  object_id: string;
}>;

export type PortableInventoryVerificationV3 =
  | Readonly<{ status: "valid" | "dependency_retryable" | "authority_quarantined"; project_id: ProjectId }>
  | Readonly<{ status: "permanently_invalid"; reason: string }>;

/**
 * This interface deliberately exposes committed portable records only. Index,
 * OPFS, recovery, custody, staging, journal, and UI sources do not implement it.
 */
export interface VerifiedPortableInventorySourceV3 {
  readonly source_kind: "committed_portable_records";
  readPortableGeneration(): Promise<UInt64>;
  listCommittedCandidates(projectId: ProjectId): Promise<readonly PortableInventoryCandidateV3[]>;
  readCommittedExact(candidate: PortableInventoryCandidateV3): Promise<Uint8Array | null>;
  verifyCommittedExact(input: PortableInventoryCandidateV3 & Readonly<{
    exact_bytes: Uint8Array;
    expected_project_id: ProjectId;
  }>): Promise<PortableInventoryVerificationV3>;
}

export type InventorySnapshotBindingV3 = Omit<
  InventorySnapshotCoreV3,
  "schema_version" | "record_kind" | "authority" | "portable_generation" |
  "descriptor_count" | "page_count" | "inventory_root_id"
>;

export type SnapshotAttemptV3 =
  | Readonly<{ status: "created"; snapshot: VerifiedInventorySnapshotV3 }>
  | Readonly<{ status: "stale_source"; reason: "portable_generation_changed" }>
  | Readonly<{ status: "corrupt"; reason: string }>;

export async function createVerifiedInventorySnapshotV3(input: Readonly<{
  source: VerifiedPortableInventorySourceV3;
  binding: InventorySnapshotBindingV3;
  maximum_descriptors_per_page?: number;
}>): Promise<SnapshotAttemptV3> {
  if (input.source?.source_kind !== "committed_portable_records") {
    throw new Error("Synchronization inventory must come from committed portable records.");
  }
  const project = parseEntityId("project", input.binding.project_id);
  const generationBefore = await input.source.readPortableGeneration();
  const candidates = await input.source.listCommittedCandidates(project);
  if (!Array.isArray(candidates)) throw new Error("Portable inventory candidates must be a dense array.");
  const byKey = new Map<string, InventoryDescriptorV3>();
  for (const candidate of candidates) {
    const exact = await input.source.readCommittedExact(candidate);
    if (!exact) return Object.freeze({ status: "corrupt", reason: "A committed portable record is unavailable." });
    const bytes = Uint8Array.from(exact);
    let verified: PortableInventoryVerificationV3;
    try {
      verified = await input.source.verifyCommittedExact({
        ...candidate,
        exact_bytes: Uint8Array.from(bytes),
        expected_project_id: project
      });
    } catch {
      return Object.freeze({ status: "corrupt", reason: "A committed portable record failed structural verification." });
    }
    if (verified.status === "permanently_invalid") continue;
    if (verified.project_id !== project) return Object.freeze({ status: "corrupt", reason: "A portable record belongs to another project." });
    const descriptor = parseInventoryDescriptorV3({
      schema_version: HC2_SYNC_SCHEMA_VERSION,
      record_kind: "inventory_descriptor_v3",
      authority: "none",
      storage_family: candidate.storage_family,
      object_kind: candidate.object_kind,
      object_id: candidate.object_id,
      exact_sha256: await sha256(bytes),
      exact_byte_length: BigInt(bytes.length)
    });
    const key = inventoryDescriptorKey(descriptor);
    const existing = byKey.get(key);
    if (existing && (!sameBytes(existing.exact_sha256, descriptor.exact_sha256) || existing.exact_byte_length !== descriptor.exact_byte_length)) {
      return Object.freeze({ status: "corrupt", reason: "Duplicate portable identity has conflicting exact bytes." });
    }
    byKey.set(key, descriptor);
  }
  const generationAfter = await input.source.readPortableGeneration();
  if (generationBefore !== generationAfter) return Object.freeze({ status: "stale_source", reason: "portable_generation_changed" });
  const descriptors = Object.freeze([...byKey.values()].sort((left, right) => compareAscii(inventoryDescriptorKey(left), inventoryDescriptorKey(right))));
  const pages = partitionInventoryDescriptorsV3(descriptors, input.maximum_descriptors_per_page);
  const inventoryRoot = await deriveInventoryRootV3(project, descriptors);
  const core = parseInventorySnapshotCoreV3({
    schema_version: HC2_SYNC_SCHEMA_VERSION,
    record_kind: "inventory_snapshot_core_v3",
    authority: "none",
    ...input.binding,
    project_id: project,
    portable_generation: generationBefore,
    descriptor_count: descriptors.length,
    page_count: pages.length,
    inventory_root_id: inventoryRoot
  });
  const snapshotId = await identifyInventorySnapshotV3(core);
  return Object.freeze({
    status: "created",
    snapshot: Object.freeze({ snapshot_id: snapshotId, core, descriptors })
  });
}

export async function deriveInventoryRootV3(
  projectId: ProjectId,
  descriptors: readonly InventoryDescriptorV3[]
): Promise<InventoryRootIdV3> {
  const project = parseEntityId("project", projectId);
  const parsed = descriptors.map(parseInventoryDescriptorV3);
  assertDescriptorOrder(parsed);
  return (await deriveSyncV3Identity("inventory-root", canonicalProtocolValue(Object.freeze({
    schema_version: HC2_SYNC_SCHEMA_VERSION,
    record_kind: "inventory_root_core_v3",
    project_id: project,
    descriptors: Object.freeze(parsed)
  })))).id;
}

export function partitionInventoryDescriptorsV3(
  descriptors: readonly InventoryDescriptorV3[],
  maximumDescriptorsPerPage: number = hc2SyncInvocationLimits.maximum_descriptors_per_page
): readonly (readonly InventoryDescriptorV3[])[] {
  if (!Number.isSafeInteger(maximumDescriptorsPerPage) || maximumDescriptorsPerPage < 1 || maximumDescriptorsPerPage > hc2SyncInvocationLimits.maximum_descriptors_per_page) throw new Error("Inventory page descriptor limit is outside the V3 bound.");
  const parsed = descriptors.map(parseInventoryDescriptorV3);
  assertDescriptorOrder(parsed);
  const pages: InventoryDescriptorV3[][] = [];
  let page: InventoryDescriptorV3[] = [];
  for (const descriptor of parsed) {
    const candidate = [...page, descriptor];
    const encodedBytes = encodeSyncProtocolValueV3(Object.freeze(candidate)).length;
    if (page.length > 0 && (
      candidate.length > maximumDescriptorsPerPage ||
      BigInt(encodedBytes) > hc2SyncInvocationLimits.maximum_page_canonical_bytes - BigInt(64 * 1024)
    )) {
      pages.push(page);
      page = [descriptor];
      if (BigInt(encodeSyncProtocolValueV3(Object.freeze(page)).length) > hc2SyncInvocationLimits.maximum_page_canonical_bytes - BigInt(64 * 1024)) {
        throw new Error("One inventory descriptor exceeds the deterministic page byte bound.");
      }
    } else {
      page = candidate;
    }
  }
  if (page.length > 0) pages.push(page);
  return Object.freeze(pages.map((entry) => Object.freeze(entry)));
}

export async function createInventoryPagesV3(input: Readonly<{
  snapshot: VerifiedInventorySnapshotV3;
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  maximum_descriptors_per_page?: number;
}>): Promise<readonly InventoryPageV3[]> {
  const pages = partitionInventoryDescriptorsV3(input.snapshot.descriptors, input.maximum_descriptors_per_page);
  if (pages.length !== input.snapshot.core.page_count) throw new Error("Snapshot page count no longer matches deterministic pagination.");
  const output: InventoryPageV3[] = [];
  for (let ordinal = 0; ordinal < pages.length; ordinal += 1) {
    const descriptors = pages[ordinal];
    const digest = parseSha256Digest(await sha256(encodeSyncProtocolValueV3(descriptors)));
    const core = parseInventoryPageCoreV3({
      schema_version: HC2_SYNC_SCHEMA_VERSION,
      record_kind: "inventory_page_core_v3",
      authority: "none",
      session_id: input.session_id,
      session_generation: input.session_generation,
      round_number: input.round_number,
      inventory_snapshot_id: input.snapshot.snapshot_id,
      page_ordinal: ordinal,
      page_count: pages.length,
      first_descriptor_key: inventoryDescriptorKey(descriptors[0]),
      last_descriptor_key: inventoryDescriptorKey(descriptors.at(-1)!),
      descriptor_count: descriptors.length,
      descriptors,
      page_digest: digest
    });
    output.push(await identifyInventoryPageV3(core));
  }
  return Object.freeze(output);
}

export type InventoryPageAssemblyV3 =
  | Readonly<{ status: "complete"; descriptors: readonly InventoryDescriptorV3[]; inventory_root_id: InventoryRootIdV3 }>
  | Readonly<{ status: "more_required"; missing_page_ordinals: readonly number[] }>
  | Readonly<{ status: "conflict"; reason: string }>;

export async function assembleInventoryPagesV3(input: Readonly<{
  project_id: ProjectId;
  snapshot_id: InventorySnapshotIdV3;
  expected_root_id: InventoryRootIdV3;
  expected_descriptor_count: number;
  expected_page_count: number;
  pages: readonly InventoryPageV3[];
}>): Promise<InventoryPageAssemblyV3> {
  const byOrdinal = new Map<number, InventoryPageV3>();
  for (const pageValue of input.pages) {
    const page = await identifyInventoryPageV3(parseInventoryPageCoreV3(pageValue.core));
    if (page.page_id !== pageValue.page_id || page.core.inventory_snapshot_id !== input.snapshot_id || page.core.page_count !== input.expected_page_count) {
      return Object.freeze({ status: "conflict", reason: "Inventory page binding or identity mismatch." });
    }
    const expectedDigest = await sha256(encodeSyncProtocolValueV3(page.core.descriptors));
    if (!sameBytes(expectedDigest, page.core.page_digest)) return Object.freeze({ status: "conflict", reason: "Inventory page digest mismatch." });
    const existing = byOrdinal.get(page.core.page_ordinal);
    if (existing && existing.page_id !== page.page_id) return Object.freeze({ status: "conflict", reason: "Duplicate page ordinal contains different bytes." });
    byOrdinal.set(page.core.page_ordinal, page);
  }
  const missing = Array.from({ length: input.expected_page_count }, (_, ordinal) => ordinal).filter((ordinal) => !byOrdinal.has(ordinal));
  if (missing.length > 0) return Object.freeze({ status: "more_required", missing_page_ordinals: Object.freeze(missing) });
  const descriptors = Object.freeze([...byOrdinal.values()]
    .sort((left, right) => left.core.page_ordinal - right.core.page_ordinal)
    .flatMap((page) => page.core.descriptors));
  try { assertDescriptorOrder(descriptors); } catch (error) {
    return Object.freeze({ status: "conflict", reason: error instanceof Error ? error.message : "Inventory page ordering is invalid." });
  }
  if (descriptors.length !== input.expected_descriptor_count) return Object.freeze({ status: "conflict", reason: "Complete inventory descriptor count mismatch." });
  const root = await deriveInventoryRootV3(input.project_id, descriptors);
  if (root !== input.expected_root_id) return Object.freeze({ status: "conflict", reason: "Complete inventory root mismatch." });
  return Object.freeze({ status: "complete", descriptors, inventory_root_id: root });
}

function assertDescriptorOrder(descriptors: readonly InventoryDescriptorV3[]): void {
  for (let index = 1; index < descriptors.length; index += 1) {
    if (inventoryDescriptorKey(descriptors[index - 1]) >= inventoryDescriptorKey(descriptors[index])) {
      throw new Error("Inventory descriptors must be strictly canonically ordered and unique.");
    }
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

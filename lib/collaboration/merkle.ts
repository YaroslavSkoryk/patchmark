import {
  canonicalArray,
  canonicalBytes,
  canonicalText,
  canonicalUint,
  encodeCanonicalCbor,
  type CanonicalValue
} from "./canonical-cbor.ts";
import { collaborationHashDomains } from "./domains.ts";
import { sha256, type Sha256Digest } from "./sha256.ts";
import { MERKLE_ROOT_SCHEMA_VERSION } from "./versions.ts";

export const merkleTreeFamilies = [
  "base_frontier",
  "accepted_history",
  "semantic_state",
  "revision_heads",
  "conflict_set"
] as const;

export type MerkleTreeFamily = (typeof merkleTreeFamilies)[number];

export type MerkleSetEntry = Readonly<{ key: CanonicalValue }>;
export type MerkleMapEntry = Readonly<{
  key: CanonicalValue;
  value: CanonicalValue;
}>;

export type PatchmarkMerkleRoot = Readonly<{
  schema_version: typeof MERKLE_ROOT_SCHEMA_VERSION;
  profile: "patchmark-merkle-v1";
  tree_kind: "set" | "map";
  tree_family: MerkleTreeFamily;
  entry_count: number;
  raw_digest: Sha256Digest;
}>;

type EncodedLeaf = Readonly<{
  key_bytes: Uint8Array;
  value_bytes: Uint8Array | null;
}>;

export async function calculateMerkleSet(
  family: MerkleTreeFamily,
  entries: readonly MerkleSetEntry[]
): Promise<PatchmarkMerkleRoot> {
  return calculateMerkle(family, "set", entries.map((entry) => ({
    key_bytes: encodeCanonicalCbor(entry.key),
    value_bytes: null
  })));
}

export async function calculateMerkleMap(
  family: MerkleTreeFamily,
  entries: readonly MerkleMapEntry[]
): Promise<PatchmarkMerkleRoot> {
  return calculateMerkle(family, "map", entries.map((entry) => ({
    key_bytes: encodeCanonicalCbor(entry.key),
    value_bytes: encodeCanonicalCbor(entry.value)
  })));
}

async function calculateMerkle(
  family: MerkleTreeFamily,
  kind: "set" | "map",
  input: readonly EncodedLeaf[]
): Promise<PatchmarkMerkleRoot> {
  if (!merkleTreeFamilies.includes(family)) {
    throw new Error("Unknown Patchmark Merkle tree family.");
  }
  const leaves = input
    .map((entry) => ({
      key_bytes: Uint8Array.from(entry.key_bytes),
      value_bytes: entry.value_bytes === null ? null : Uint8Array.from(entry.value_bytes)
    }))
    .sort((left, right) => compareBytes(left.key_bytes, right.key_bytes));
  for (let index = 1; index < leaves.length; index += 1) {
    if (compareBytes(leaves[index - 1].key_bytes, leaves[index].key_bytes) === 0) {
      throw new Error("Patchmark Merkle trees reject duplicate canonical keys.");
    }
  }
  let digest: Sha256Digest;
  if (leaves.length === 0) {
    digest = await hash([
      canonicalText(collaborationHashDomains.merkleEmpty),
      canonicalText(family),
      canonicalText(kind)
    ]);
  } else {
    let level = await Promise.all(leaves.map((leaf) =>
      kind === "set"
        ? hash([
            canonicalText(collaborationHashDomains.merkleSetLeaf),
            canonicalText(family),
            canonicalBytes(leaf.key_bytes)
          ])
        : hash([
            canonicalText(collaborationHashDomains.merkleMapLeaf),
            canonicalText(family),
            canonicalBytes(leaf.key_bytes),
            canonicalBytes(requiredValue(leaf))
          ])
    ));
    let levelIndex = 0;
    while (level.length > 1) {
      const next: Sha256Digest[] = [];
      for (let index = 0; index < level.length; index += 2) {
        const right = level[index + 1] ?? null;
        next.push(await hash([
          canonicalText(collaborationHashDomains.merkleInternal),
          canonicalText(family),
          canonicalText(kind),
          canonicalUint(BigInt(levelIndex)),
          canonicalUint(BigInt(index / 2)),
          canonicalBytes(level[index]),
          right === null ? canonicalArray([]) : canonicalArray([canonicalBytes(right)])
        ]));
      }
      level = next;
      levelIndex += 1;
    }
    digest = level[0];
  }
  return Object.freeze({
    schema_version: MERKLE_ROOT_SCHEMA_VERSION,
    profile: "patchmark-merkle-v1" as const,
    tree_kind: kind,
    tree_family: family,
    entry_count: leaves.length,
    raw_digest: Uint8Array.from(digest) as Sha256Digest
  });
}

async function hash(values: readonly CanonicalValue[]): Promise<Sha256Digest> {
  return sha256(encodeCanonicalCbor(canonicalArray(values)));
}

function requiredValue(leaf: EncodedLeaf): Uint8Array {
  if (leaf.value_bytes === null) throw new Error("Merkle map leaf has no value.");
  return leaf.value_bytes;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

import { parseSha256Digest, type Sha256Digest } from "../sha256.ts";
import { calculatePortableBundleEncodedLength, hc2ProtocolLimits } from "./limits.ts";
import type { IncrementalSha256, TransportBundleSink, TransportBundleSource } from "./transport-bundle-framing.ts";
import {
  decodeEncryptedContainerRecordV3,
  encodeEncryptedContainerRecordV3,
  type EncryptedContainerRecordV3
} from "./transport-v3-contracts.ts";

export type SyncBundleEvidenceV3 = Readonly<{
  byte_length: bigint;
  sha256: Sha256Digest;
  container_count: number;
  container_ids: readonly EncryptedContainerRecordV3["container_id"][];
}>;

/** Canonical, bounded, incremental manual-file writer for V3 only. */
export async function writeCanonicalTransportBundleV3(input: Readonly<{
  containers: readonly EncryptedContainerRecordV3[];
  sink: TransportBundleSink;
  sha256: IncrementalSha256;
}>): Promise<SyncBundleEvidenceV3> {
  if (!Array.isArray(input.containers) || input.containers.length === 0 || input.containers.length > hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error("V3 bundle requires one through 4096 containers.");
  const encoded = input.containers.map(encodeEncryptedContainerRecordV3);
  const total = calculatePortableBundleEncodedLength(encoded.map((entry) => BigInt(entry.length)));
  let written = BigInt(0);
  const write = async (bytes: Uint8Array): Promise<void> => {
    written += BigInt(bytes.length);
    if (written > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) throw new Error("V3 bundle exceeds the frozen 256 MiB limit.");
    input.sha256.update(bytes);
    await input.sink.write(Uint8Array.from(bytes));
  };
  try {
    await write(encodeArrayHeader(encoded.length));
    for (const bytes of encoded) await write(bytes);
    if (written !== total) throw new Error("V3 bundle writer length invariant failed.");
    await input.sink.close();
  } catch (error) { await input.sink.abort(error); throw error; }
  return Object.freeze({ byte_length: written, sha256: parseSha256Digest(Uint8Array.from(await input.sha256.digest())), container_count: encoded.length, container_ids: Object.freeze(input.containers.map((entry) => entry.container_id)) });
}

/** Parses one canonical array and releases each verified V3 record in order. */
export async function readCanonicalTransportBundleV3(input: Readonly<{
  source: TransportBundleSource;
  sha256: IncrementalSha256;
  on_container: (container: EncryptedContainerRecordV3, exactBytes: Uint8Array) => Promise<void>;
}>): Promise<SyncBundleEvidenceV3> {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let expectedCount: number | null = null;
  let count = 0;
  let total = BigInt(0);
  const ids: EncryptedContainerRecordV3["container_id"][] = [];
  for await (const supplied of input.source.chunks()) {
    if (!(supplied instanceof Uint8Array) || supplied.length === 0) throw new Error("V3 source yielded an invalid byte chunk.");
    total += BigInt(supplied.length);
    if (total > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) throw new Error("V3 bundle exceeds the frozen 256 MiB limit.");
    input.sha256.update(supplied);
    buffer = append(buffer, supplied);
    if (expectedCount === null) {
      const header = readArrayHeader(buffer);
      if (!header) continue;
      expectedCount = header.count;
      buffer = buffer.slice(header.length);
    }
    while (expectedCount !== null && count < expectedCount) {
      const length = scanItem(buffer, 0, 0);
      if (length === null) break;
      if (BigInt(length) > hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes + BigInt(1024)) throw new Error("V3 container record exceeds its bound.");
      const exact = buffer.slice(0, length);
      buffer = buffer.slice(length);
      const container = await decodeEncryptedContainerRecordV3(exact);
      if (container.core.public_header.chunk_ordinal !== count || container.core.public_header.chunk_count !== expectedCount) throw new Error("V3 container headers are not a complete dense ordered set.");
      ids.push(container.container_id);
      await input.on_container(container, Uint8Array.from(exact));
      count += 1;
    }
  }
  if (expectedCount === null || count !== expectedCount || buffer.length !== 0) throw new Error("V3 bundle ended incomplete or contains trailing bytes.");
  return Object.freeze({ byte_length: total, sha256: parseSha256Digest(Uint8Array.from(await input.sha256.digest())), container_count: count, container_ids: Object.freeze(ids) });
}

function encodeArrayHeader(count: number): Uint8Array {
  if (count < 24) return Uint8Array.of(0x80 | count);
  if (count <= 0xff) return Uint8Array.of(0x98, count);
  return Uint8Array.of(0x99, count >>> 8, count & 0xff);
}

function readArrayHeader(bytes: Uint8Array): Readonly<{ count: number; length: number }> | null {
  if (bytes.length === 0) return null;
  if ((bytes[0] >>> 5) !== 4) throw new Error("V3 transport file must be one canonical CBOR array.");
  const additional = bytes[0] & 31;
  if (additional < 24) return boundedHeader(additional, 1);
  if (additional === 24) {
    if (bytes.length < 2) return null;
    if (bytes[1] < 24) throw new Error("V3 array header is not shortest form.");
    return boundedHeader(bytes[1], 2);
  }
  if (additional === 25) {
    if (bytes.length < 3) return null;
    const count = bytes[1] * 256 + bytes[2];
    if (count <= 0xff) throw new Error("V3 array header is not shortest form.");
    return boundedHeader(count, 3);
  }
  throw new Error("V3 array header is indefinite or unsupported.");
}

function boundedHeader(count: number, length: number): Readonly<{ count: number; length: number }> {
  if (count < 1 || count > hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error("V3 array count exceeds the frozen limit.");
  return Object.freeze({ count, length });
}

function scanItem(bytes: Uint8Array, offset: number, depth: number): number | null {
  if (depth > hc2ProtocolLimits.maximum_dependency_depth) throw new Error("V3 CBOR nesting exceeds the frozen depth limit.");
  if (offset >= bytes.length) return null;
  const major = bytes[offset] >>> 5;
  const head = readHead(bytes, offset);
  if (!head) return null;
  let cursor = offset + head.length;
  if (major === 0) return cursor;
  if (major === 2 || major === 3) {
    if (head.argument > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("V3 CBOR item length is unsafe.");
    const end = cursor + Number(head.argument);
    return end <= bytes.length ? end : null;
  }
  if (major === 4 || major === 5) {
    if (head.argument > BigInt(hc2ProtocolLimits.maximum_chunks_per_bundle * 64)) throw new Error("V3 CBOR collection is unreasonably large.");
    const children = Number(head.argument) * (major === 5 ? 2 : 1);
    for (let index = 0; index < children; index += 1) {
      const end = scanItem(bytes, cursor, depth + 1);
      if (end === null) return null;
      cursor = end;
    }
    return cursor;
  }
  if (major === 7 && [0xf4, 0xf5, 0xf6].includes(bytes[offset])) return cursor;
  throw new Error("V3 transport contains unsupported CBOR.");
}

function readHead(bytes: Uint8Array, offset: number): Readonly<{ argument: bigint; length: number }> | null {
  const additional = bytes[offset] & 31;
  if (additional < 24) return Object.freeze({ argument: BigInt(additional), length: 1 });
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (width === 0) throw new Error("V3 CBOR contains indefinite or unsupported heads.");
  if (offset + 1 + width > bytes.length) return null;
  let argument = BigInt(0);
  for (let index = 0; index < width; index += 1) argument = (argument << BigInt(8)) | BigInt(bytes[offset + index + 1]);
  if ((width === 1 && argument < BigInt(24)) || (width === 2 && argument <= BigInt(0xff)) || (width === 4 && argument <= BigInt(0xffff)) || (width === 8 && argument <= BigInt(0xffffffff))) throw new Error("V3 CBOR head is not shortest form.");
  return Object.freeze({ argument, length: width + 1 });
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left); output.set(right, left.length); return output;
}

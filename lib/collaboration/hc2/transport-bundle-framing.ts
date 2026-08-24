import { parseSha256Digest, type Sha256Digest } from "../sha256.ts";
import {
  calculatePortableBundleEncodedLength,
  hc2ProtocolLimits
} from "./limits.ts";
import {
  decodeEncryptedContainerRecordV2,
  encodeEncryptedContainerRecordV2,
  type EncryptedContainerRecordV2
} from "./transport-v2-contracts.ts";

export interface IncrementalSha256 {
  update(bytes: Uint8Array): void;
  digest(): Promise<Uint8Array> | Uint8Array;
}

export interface TransportBundleSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

export interface TransportBundleSource {
  chunks(): AsyncIterable<Uint8Array>;
}

export type TransportBundleWriteEvidence = Readonly<{
  byte_length: bigint;
  sha256: Sha256Digest;
  container_count: number;
  container_ids: readonly EncryptedContainerRecordV2["container_id"][];
}>;

export async function writeCanonicalTransportBundleV2(input: Readonly<{
  containers: readonly EncryptedContainerRecordV2[];
  sink: TransportBundleSink;
  sha256: IncrementalSha256;
}>): Promise<TransportBundleWriteEvidence> {
  if (!Array.isArray(input.containers) || input.containers.length === 0 || input.containers.length > hc2ProtocolLimits.maximum_chunks_per_bundle) {
    throw new Error("Transport bundle requires one through 4096 containers.");
  }
  const lengths = input.containers.map((entry) => BigInt(encodeEncryptedContainerRecordV2(entry).length));
  const header = encodeCanonicalArrayHeader(input.containers.length);
  const total = calculatePortableBundleEncodedLength(lengths);
  let written = BigInt(0);
  try {
    await write(header);
    for (const container of input.containers) await write(encodeEncryptedContainerRecordV2(container));
    if (written !== total) throw new Error("Transport bundle writer length invariant failed.");
    await input.sink.close();
  } catch (error) {
    await input.sink.abort(error);
    throw error;
  }
  const digest = parseSha256Digest(Uint8Array.from(await input.sha256.digest()));
  return Object.freeze({
    byte_length: written,
    sha256: digest,
    container_count: input.containers.length,
    container_ids: Object.freeze(input.containers.map((entry) => entry.container_id))
  });

  async function write(bytes: Uint8Array): Promise<void> {
    written += BigInt(bytes.length);
    if (written > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) throw new Error("Transport bundle exceeds the frozen 256 MiB limit.");
    input.sha256.update(bytes);
    await input.sink.write(Uint8Array.from(bytes));
  }
}

export async function readCanonicalTransportBundleV2(input: Readonly<{
  source: TransportBundleSource;
  sha256: IncrementalSha256;
  on_container: (container: EncryptedContainerRecordV2, exactBytes: Uint8Array) => Promise<void>;
}>): Promise<TransportBundleWriteEvidence> {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let expectedCount: number | null = null;
  let count = 0;
  let total = BigInt(0);
  const ids: EncryptedContainerRecordV2["container_id"][] = [];
  for await (const supplied of input.source.chunks()) {
    if (!(supplied instanceof Uint8Array) || supplied.length === 0) throw new Error("Transport source yielded an invalid byte chunk.");
    total += BigInt(supplied.length);
    if (total > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) throw new Error("Transport bundle exceeds the frozen 256 MiB limit.");
    input.sha256.update(supplied);
    buffer = append(buffer, supplied);
    if (expectedCount === null) {
      const head = readCanonicalArrayHeader(buffer);
      if (head === null) continue;
      expectedCount = head.count;
      buffer = buffer.slice(head.byte_length);
    }
    while (expectedCount !== null && count < expectedCount) {
      const length = scanCanonicalCborItemLength(buffer);
      if (length === null) break;
      if (BigInt(length) > hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes + BigInt(1024)) throw new Error("Transport container record exceeds its frozen bound.");
      const exact = buffer.slice(0, length);
      buffer = buffer.slice(length);
      const container = await decodeEncryptedContainerRecordV2(exact);
      if (container.core.public_header.chunk_ordinal !== count || container.core.public_header.chunk_count !== expectedCount) {
        throw new Error("Transport container headers are not a dense complete ordered set.");
      }
      ids.push(container.container_id);
      count += 1;
      await input.on_container(container, Uint8Array.from(exact));
    }
  }
  if (expectedCount === null || count !== expectedCount || buffer.length !== 0) throw new Error("Transport bundle ended incomplete or contains trailing bytes.");
  const digest = parseSha256Digest(Uint8Array.from(await input.sha256.digest()));
  return Object.freeze({
    byte_length: total,
    sha256: digest,
    container_count: count,
    container_ids: Object.freeze(ids)
  });
}

function encodeCanonicalArrayHeader(count: number): Uint8Array {
  if (!Number.isSafeInteger(count) || count < 1 || count > hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error("Transport array count is outside the frozen bound.");
  if (count < 24) return Uint8Array.of(0x80 | count);
  if (count <= 0xff) return Uint8Array.of(0x98, count);
  return Uint8Array.of(0x99, count >>> 8, count & 0xff);
}

function readCanonicalArrayHeader(bytes: Uint8Array): Readonly<{ count: number; byte_length: number }> | null {
  if (bytes.length === 0) return null;
  const first = bytes[0];
  if ((first >>> 5) !== 4) throw new Error("Transport file must be one canonical CBOR array.");
  const additional = first & 31;
  if (additional < 24) {
    if (additional === 0) throw new Error("Transport bundle array must not be empty.");
    return Object.freeze({ count: additional, byte_length: 1 });
  }
  if (additional === 24) {
    if (bytes.length < 2) return null;
    if (bytes[1] < 24) throw new Error("Transport array header is not shortest-form canonical CBOR.");
    return boundedHeader(bytes[1], 2);
  }
  if (additional === 25) {
    if (bytes.length < 3) return null;
    const count = bytes[1] * 256 + bytes[2];
    if (count <= 0xff) throw new Error("Transport array header is not shortest-form canonical CBOR.");
    return boundedHeader(count, 3);
  }
  throw new Error("Transport array count uses an unsupported or indefinite CBOR head.");
}

function boundedHeader(count: number, byteLength: number): Readonly<{ count: number; byte_length: number }> {
  if (count < 1 || count > hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error("Transport array count exceeds the frozen limit.");
  return Object.freeze({ count, byte_length: byteLength });
}

/** Returns one definite-length CBOR item's byte length, or null when incomplete. */
function scanCanonicalCborItemLength(bytes: Uint8Array): number | null {
  const scanned = scan(bytes, 0, 0);
  return scanned === null ? null : scanned;
}

function scan(bytes: Uint8Array, offset: number, depth: number): number | null {
  if (depth > hc2ProtocolLimits.maximum_dependency_depth) throw new Error("Transport CBOR nesting exceeds the frozen depth limit.");
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  const major = first >>> 5;
  const head = readItemHead(bytes, offset);
  if (head === null) return null;
  const { argument, byte_length: headLength } = head;
  let cursor = offset + headLength;
  if (major === 0) return cursor;
  if (major === 2 || major === 3) {
    if (argument > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Transport CBOR item length is unsafe.");
    const end = cursor + Number(argument);
    return end <= bytes.length ? end : null;
  }
  if (major === 4 || major === 5) {
    if (argument > BigInt(hc2ProtocolLimits.maximum_chunks_per_bundle * 64)) throw new Error("Transport CBOR collection is unreasonably large.");
    const children = Number(argument) * (major === 5 ? 2 : 1);
    for (let index = 0; index < children; index += 1) {
      const end = scan(bytes, cursor, depth + 1);
      if (end === null) return null;
      cursor = end;
    }
    return cursor;
  }
  if (major === 7 && (first === 0xf4 || first === 0xf5 || first === 0xf6)) return cursor;
  throw new Error("Transport file contains unsupported, indefinite, or non-protocol CBOR.");
}

function readItemHead(bytes: Uint8Array, offset: number): Readonly<{ argument: bigint; byte_length: number }> | null {
  const additional = bytes[offset] & 31;
  if (additional < 24) return Object.freeze({ argument: BigInt(additional), byte_length: 1 });
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (width === 0) throw new Error("Transport file contains indefinite or unsupported CBOR.");
  if (offset + 1 + width > bytes.length) return null;
  let value = BigInt(0);
  for (let index = 0; index < width; index += 1) value = (value << BigInt(8)) | BigInt(bytes[offset + 1 + index]);
  if ((width === 1 && value < BigInt(24)) || (width === 2 && value <= BigInt(0xff)) || (width === 4 && value <= BigInt(0xffff)) || (width === 8 && value <= BigInt(0xffffffff))) {
    throw new Error("Transport CBOR head is not shortest-form canonical encoding.");
  }
  return Object.freeze({ argument: value, byte_length: 1 + width });
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

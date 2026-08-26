import { parseSha256Digest, type Sha256Digest } from "../sha256.ts";
import { hc2ProtocolLimits } from "../hc2/limits.ts";
import {
  readCanonicalTransportBundleV2,
  type IncrementalSha256,
  type TransportBundleWriteEvidence
} from "../hc2/transport-bundle-framing.ts";
import {
  readCanonicalTransportBundleV3,
  type SyncBundleEvidenceV3
} from "../hc2/transport-v3-framing.ts";
import {
  HC3_ENCRYPTED_BUNDLE_EXTENSION,
  HC3_ENCRYPTED_BUNDLE_MEDIA_TYPE
} from "./versions.ts";

export type Hc3EncryptedBundleVersion = 2 | 3;

export type Hc3EncryptedBundleFileEvidence = Readonly<{
  authority: "none";
  bundle_version: Hc3EncryptedBundleVersion;
  exact_byte_length: bigint;
  sha256: Sha256Digest;
  container_count: number;
  container_ids: readonly string[];
}>;

export interface Hc3IncrementalSha256Factory {
  createSha256(): IncrementalSha256;
}

export async function inspectHc3EncryptedBundleFile(input: Readonly<{
  exact_bytes: Uint8Array;
  sha256_factory: Hc3IncrementalSha256Factory;
}>): Promise<Hc3EncryptedBundleFileEvidence> {
  if (!(input.exact_bytes instanceof Uint8Array) || input.exact_bytes.byteLength === 0) {
    throw new Error("HC-3 encrypted bundle file must contain bytes.");
  }
  if (BigInt(input.exact_bytes.byteLength) > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) {
    throw new Error("HC-3 encrypted bundle file exceeds the HC-2 portable bundle limit.");
  }
  if (!input.sha256_factory || typeof input.sha256_factory.createSha256 !== "function") {
    throw new Error("HC-3 bundle inspection requires an injected incremental SHA-256 factory.");
  }

  const v2 = await attemptV2(input.exact_bytes, input.sha256_factory);
  const v3 = await attemptV3(input.exact_bytes, input.sha256_factory);
  if ((v2 === null) === (v3 === null)) {
    throw new Error("Encrypted bundle is malformed, truncated, appended, mixed-version, or unsupported.");
  }
  const version = v2 ? 2 : 3;
  const evidence = v2 ?? v3;
  if (!evidence) throw new Error("Encrypted bundle version detection failed closed.");
  return Object.freeze({
    authority: "none",
    bundle_version: version,
    exact_byte_length: evidence.byte_length,
    sha256: parseSha256Digest(evidence.sha256),
    container_count: evidence.container_count,
    container_ids: Object.freeze([...evidence.container_ids])
  });
}

export function createHc3EncryptedBundleFilename(value: Sha256Digest): string {
  const digest = parseSha256Digest(value);
  return `patchmark-${hex(digest)}${HC3_ENCRYPTED_BUNDLE_EXTENSION}`;
}

export function parseHc3EncryptedBundleFilename(value: unknown): Readonly<{
  authority: "none";
  sha256: Sha256Digest;
  extension: typeof HC3_ENCRYPTED_BUNDLE_EXTENSION;
}> {
  if (typeof value !== "string") throw new Error("HC-3 encrypted bundle filename must be text.");
  const match = /^patchmark-([0-9a-f]{64})\.pmcb$/.exec(value);
  if (!match) throw new Error("HC-3 encrypted bundle filename is not canonical or exposes unsupported metadata.");
  return Object.freeze({
    authority: "none",
    sha256: parseSha256Digest(bytesFromHex(match[1])),
    extension: HC3_ENCRYPTED_BUNDLE_EXTENSION
  });
}

export function hc3EncryptedBundleFileMetadata(): Readonly<{
  authority: "none";
  extension: typeof HC3_ENCRYPTED_BUNDLE_EXTENSION;
  media_type: typeof HC3_ENCRYPTED_BUNDLE_MEDIA_TYPE;
  detection: "versioned_structure_reauthenticated_by_hc2_import";
}> {
  return Object.freeze({
    authority: "none",
    extension: HC3_ENCRYPTED_BUNDLE_EXTENSION,
    media_type: HC3_ENCRYPTED_BUNDLE_MEDIA_TYPE,
    detection: "versioned_structure_reauthenticated_by_hc2_import"
  });
}

async function attemptV2(
  bytes: Uint8Array,
  factory: Hc3IncrementalSha256Factory
): Promise<TransportBundleWriteEvidence | null> {
  try {
    return await readCanonicalTransportBundleV2({
      source: oneChunkSource(bytes),
      sha256: factory.createSha256(),
      async on_container() {}
    });
  } catch {
    return null;
  }
}

async function attemptV3(
  bytes: Uint8Array,
  factory: Hc3IncrementalSha256Factory
): Promise<SyncBundleEvidenceV3 | null> {
  try {
    return await readCanonicalTransportBundleV3({
      source: oneChunkSource(bytes),
      sha256: factory.createSha256(),
      async on_container() {}
    });
  } catch {
    return null;
  }
}

function oneChunkSource(bytes: Uint8Array) {
  return Object.freeze({
    async *chunks(): AsyncIterable<Uint8Array> {
      yield bytes;
    }
  });
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

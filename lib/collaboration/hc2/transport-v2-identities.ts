import {
  canonicalArray,
  canonicalText,
  encodeCanonicalCbor,
  type CanonicalValue
} from "../canonical-cbor.ts";
import { decodeSha256Base32, encodeSha256Base32 } from "../base32.ts";
import { sha256, type Sha256Digest, type Sha256Provider } from "../sha256.ts";
import { hc2TransportV2HashDomains } from "./transport-v2-versions.ts";

declare const transportV2IdBrand: unique symbol;

export const transportV2IdKinds = [
  "transport-payload",
  "bundle-manifest",
  "encrypted-container",
  "transport-stream",
  "transport-attachment",
  "transport-attachment-marker",
  "transport-attachment-batch"
] as const;

export type TransportV2IdKind = (typeof transportV2IdKinds)[number];
export type TransportV2Id<TKind extends TransportV2IdKind> = string & {
  readonly [transportV2IdBrand]: TKind;
};
export type TransportPayloadIdV2 = TransportV2Id<"transport-payload">;
export type BundleManifestIdV2 = TransportV2Id<"bundle-manifest">;
export type EncryptedContainerIdV2 = TransportV2Id<"encrypted-container">;
export type TransportStreamIdV2 = TransportV2Id<"transport-stream">;
export type TransportAttachmentIdV2 = TransportV2Id<"transport-attachment">;
export type TransportAttachmentMarkerIdV2 = TransportV2Id<"transport-attachment-marker">;
export type TransportAttachmentBatchIdV2 = TransportV2Id<"transport-attachment-batch">;

const domains = Object.freeze({
  "transport-payload": hc2TransportV2HashDomains.payload,
  "bundle-manifest": hc2TransportV2HashDomains.manifest,
  "encrypted-container": hc2TransportV2HashDomains.encryptedContainer,
  "transport-stream": hc2TransportV2HashDomains.stream,
  "transport-attachment": hc2TransportV2HashDomains.attachment,
  "transport-attachment-marker": hc2TransportV2HashDomains.attachmentCommitMarker,
  "transport-attachment-batch": hc2TransportV2HashDomains.attachmentBatch
} as const satisfies Readonly<Record<TransportV2IdKind, string>>);

export function parseTransportV2Id<TKind extends TransportV2IdKind>(
  kind: TKind,
  value: unknown
): TransportV2Id<TKind> {
  if (!transportV2IdKinds.includes(kind)) {
    throw new Error("Unsupported HC-2 transport v2 identity kind.");
  }
  const prefix = `pm:${kind}:v2:`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${kind} ID must use the canonical ${prefix} namespace.`);
  }
  try {
    decodeSha256Base32(value.slice(prefix.length));
  } catch {
    throw new Error(`${kind} ID must use lowercase unpadded SHA-256 Base32.`);
  }
  return value as TransportV2Id<TKind>;
}

export async function deriveTransportV2Identity<TKind extends TransportV2IdKind>(
  kind: TKind,
  core: CanonicalValue,
  provider?: Sha256Provider
): Promise<Readonly<{
  id: TransportV2Id<TKind>;
  digest: Sha256Digest;
  canonical_preimage_bytes: Uint8Array;
}>> {
  const preimage = encodeCanonicalCbor(
    canonicalArray([canonicalText(domains[kind]), core])
  );
  const digest = await sha256(preimage, provider);
  return Object.freeze({
    id: parseTransportV2Id(
      kind,
      `pm:${kind}:v2:${encodeSha256Base32(digest)}`
    ),
    digest,
    canonical_preimage_bytes: Uint8Array.from(preimage)
  });
}

export function transportV2IdSuffix<TKind extends TransportV2IdKind>(
  kind: TKind,
  value: TransportV2Id<TKind>
): string {
  const parsed = parseTransportV2Id(kind, value);
  return parsed.slice(parsed.lastIndexOf(":") + 1);
}

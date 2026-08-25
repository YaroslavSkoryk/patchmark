import {
  canonicalArray,
  canonicalText,
  encodeCanonicalCbor,
  type CanonicalValue
} from "../canonical-cbor.ts";
import { decodeSha256Base32, encodeSha256Base32 } from "../base32.ts";
import { sha256, type Sha256Digest, type Sha256Provider } from "../sha256.ts";
import { hc2SyncV3HashDomains } from "./sync-v3-versions.ts";

declare const syncV3IdBrand: unique symbol;

export const syncV3IdKinds = [
  "inventory-descriptor",
  "inventory-root",
  "inventory-snapshot",
  "inventory-page",
  "sync-session",
  "object-request",
  "object-response",
  "sync-confirmation",
  "transport-payload",
  "bundle-manifest",
  "encrypted-container",
  "transport-stream"
] as const;

export type SyncV3IdKind = (typeof syncV3IdKinds)[number];
export type SyncV3Id<TKind extends SyncV3IdKind> = string & {
  readonly [syncV3IdBrand]: TKind;
};
export type InventoryDescriptorIdV3 = SyncV3Id<"inventory-descriptor">;
export type InventoryRootIdV3 = SyncV3Id<"inventory-root">;
export type InventorySnapshotIdV3 = SyncV3Id<"inventory-snapshot">;
export type InventoryPageIdV3 = SyncV3Id<"inventory-page">;
export type SyncSessionIdV3 = SyncV3Id<"sync-session">;
export type ObjectRequestIdV3 = SyncV3Id<"object-request">;
export type ObjectResponseIdV3 = SyncV3Id<"object-response">;
export type SyncConfirmationIdV3 = SyncV3Id<"sync-confirmation">;
export type TransportPayloadIdV3 = SyncV3Id<"transport-payload">;
export type BundleManifestIdV3 = SyncV3Id<"bundle-manifest">;
export type EncryptedContainerIdV3 = SyncV3Id<"encrypted-container">;
export type TransportStreamIdV3 = SyncV3Id<"transport-stream">;

const domains = Object.freeze({
  "inventory-descriptor": hc2SyncV3HashDomains.descriptor,
  "inventory-root": hc2SyncV3HashDomains.inventoryRoot,
  "inventory-snapshot": hc2SyncV3HashDomains.inventorySnapshot,
  "inventory-page": hc2SyncV3HashDomains.inventoryPage,
  "sync-session": hc2SyncV3HashDomains.session,
  "object-request": hc2SyncV3HashDomains.request,
  "object-response": hc2SyncV3HashDomains.response,
  "sync-confirmation": hc2SyncV3HashDomains.confirmation,
  "transport-payload": hc2SyncV3HashDomains.payload,
  "bundle-manifest": hc2SyncV3HashDomains.manifest,
  "encrypted-container": hc2SyncV3HashDomains.encryptedContainer,
  "transport-stream": hc2SyncV3HashDomains.stream
} as const satisfies Readonly<Record<SyncV3IdKind, string>>);

export function parseSyncV3Id<TKind extends SyncV3IdKind>(
  kind: TKind,
  value: unknown
): SyncV3Id<TKind> {
  if (!syncV3IdKinds.includes(kind)) throw new Error("Unsupported HC-2 synchronization v3 identity kind.");
  const prefix = `pm:${kind}:v3:`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${kind} ID must use the canonical ${prefix} namespace.`);
  }
  try {
    decodeSha256Base32(value.slice(prefix.length));
  } catch {
    throw new Error(`${kind} ID must use lowercase unpadded SHA-256 Base32.`);
  }
  return value as SyncV3Id<TKind>;
}

export async function deriveSyncV3Identity<TKind extends SyncV3IdKind>(
  kind: TKind,
  core: CanonicalValue,
  provider?: Sha256Provider
): Promise<Readonly<{
  id: SyncV3Id<TKind>;
  digest: Sha256Digest;
  canonical_preimage_bytes: Uint8Array;
}>> {
  const preimage = encodeCanonicalCbor(canonicalArray([
    canonicalText(domains[kind]),
    core
  ]));
  const digest = await sha256(preimage, provider);
  return Object.freeze({
    id: parseSyncV3Id(kind, `pm:${kind}:v3:${encodeSha256Base32(digest)}`),
    digest,
    canonical_preimage_bytes: Uint8Array.from(preimage)
  });
}

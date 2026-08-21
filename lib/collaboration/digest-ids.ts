import { decodeSha256Base32, encodeSha256Base32 } from "./base32.ts";
import {
  digestIdKinds,
  parseDigestId,
  type DigestIdByKind,
  type DigestIdKind
} from "./identities.ts";
import { parseSha256Digest, type Sha256Digest } from "./sha256.ts";

export function formatDigestId<TKind extends DigestIdKind>(
  kind: TKind,
  digest: Sha256Digest | Uint8Array
): DigestIdByKind[TKind] {
  if (!digestIdKinds.includes(kind)) {
    throw new Error("Digest ID kind has an unsupported value.");
  }
  const rawDigest = parseSha256Digest(digest);
  return parseDigestId(kind, `pm:${kind}:v1:${encodeSha256Base32(rawDigest)}`);
}

export function digestBytesFromId<TKind extends DigestIdKind>(
  kind: TKind,
  value: DigestIdByKind[TKind] | unknown
): Sha256Digest {
  const id = parseDigestId(kind, value);
  const prefix = `pm:${kind}:v1:`;
  return parseSha256Digest(decodeSha256Base32(id.slice(prefix.length)));
}

import type { PatchmarkComment } from "../project/project-types.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function createReviewBatchSha256(value: string): Promise<string> {
  const subtleCrypto = globalThis.crypto?.subtle;
  if (!subtleCrypto) {
    throw new Error("SHA-256 is unavailable in this browser.");
  }
  const digest = await subtleCrypto.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createReviewBatchCommentFingerprint(
  comment: PatchmarkComment
): Promise<string> {
  return createReviewBatchSha256(stableStringify(comment));
}

export function isReviewBatchSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

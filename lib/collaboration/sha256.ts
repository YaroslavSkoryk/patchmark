export type Sha256Provider = (
  input: Uint8Array
) => Promise<Uint8Array>;

declare const sha256DigestBrand: unique symbol;
export type Sha256Digest = Uint8Array & {
  readonly [sha256DigestBrand]: "sha256";
};

export async function sha256(
  input: Uint8Array,
  provider: Sha256Provider = webCryptoSha256
): Promise<Sha256Digest> {
  if (!(input instanceof Uint8Array)) {
    throw new Error("SHA-256 input must be a Uint8Array.");
  }
  if (typeof provider !== "function") {
    throw new Error("SHA-256 provider must be a function.");
  }
  const copiedInput = Uint8Array.from(input);
  const digest = await provider(copiedInput);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) {
    throw new Error("SHA-256 provider must return exactly 32 bytes.");
  }
  return parseSha256Digest(digest);
}

export async function webCryptoSha256(input: Uint8Array): Promise<Uint8Array> {
  if (!(input instanceof Uint8Array)) {
    throw new Error("SHA-256 input must be a Uint8Array.");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Secure SHA-256 is unavailable in this runtime.");
  }
  const copiedInput = Uint8Array.from(input);
  const digest = await subtle.digest("SHA-256", copiedInput);
  const output = new Uint8Array(digest);
  if (output.length !== 32) {
    throw new Error("The runtime SHA-256 provider returned an invalid digest length.");
  }
  return Uint8Array.from(output);
}

export function parseSha256Digest(value: Uint8Array): Sha256Digest {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error("A raw SHA-256 digest must contain exactly 32 bytes.");
  }
  return Uint8Array.from(value) as Sha256Digest;
}

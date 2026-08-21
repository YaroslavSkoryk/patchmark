const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const alphabetIndexes = new Map(
  Array.from(alphabet, (character, index) => [character, index] as const)
);
const sha256ByteLength = 32;
const sha256Base32Length = 52;

export function encodeSha256Base32(digest: Uint8Array): string {
  if (!(digest instanceof Uint8Array) || digest.length !== sha256ByteLength) {
    throw new Error("Base32 SHA-256 encoding requires exactly 32 bytes.");
  }
  const input = Uint8Array.from(digest);
  let accumulator = 0;
  let availableBits = 0;
  let output = "";
  for (const byte of input) {
    accumulator = (accumulator << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5) {
      availableBits -= 5;
      output += alphabet[(accumulator >>> availableBits) & 0x1f];
      accumulator &= (1 << availableBits) - 1;
    }
  }
  if (availableBits > 0) {
    output += alphabet[(accumulator << (5 - availableBits)) & 0x1f];
  }
  if (output.length !== sha256Base32Length) {
    throw new Error("Base32 SHA-256 encoding produced an invalid length.");
  }
  return output;
}

export function decodeSha256Base32(value: string): Uint8Array {
  if (typeof value !== "string" || value.length !== sha256Base32Length) {
    throw new Error("Base32 SHA-256 text must contain exactly 52 characters.");
  }
  if (value !== value.toLowerCase()) {
    throw new Error("Base32 SHA-256 text must be lowercase.");
  }
  let accumulator = 0;
  let availableBits = 0;
  const output: number[] = [];
  for (const character of value) {
    const index = alphabetIndexes.get(character);
    if (index === undefined) {
      throw new Error("Base32 SHA-256 text contains an invalid character.");
    }
    accumulator = (accumulator << 5) | index;
    availableBits += 5;
    while (availableBits >= 8) {
      availableBits -= 8;
      output.push((accumulator >>> availableBits) & 0xff);
      accumulator &= (1 << availableBits) - 1;
    }
  }
  if (availableBits !== 4 || accumulator !== 0) {
    throw new Error("Base32 SHA-256 text has nonzero unused trailing bits.");
  }
  if (output.length !== sha256ByteLength) {
    throw new Error("Base32 SHA-256 text did not decode to exactly 32 bytes.");
  }
  return Uint8Array.from(output);
}

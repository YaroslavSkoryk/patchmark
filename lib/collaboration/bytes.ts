export function bytesToHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Hex encoding requires a Uint8Array.");
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (
    typeof hex !== "string" ||
    hex.length % 2 !== 0 ||
    !/^(?:[0-9a-f]{2})*$/.test(hex)
  ) {
    throw new Error("Hex input must contain an even number of lowercase hexadecimal characters.");
  }
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left instanceof Uint8Array &&
    right instanceof Uint8Array &&
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

/** Test-only model of a person manually moving opaque encrypted files. */
export type ManualArtifactFault = "none" | "permission_denied" | "truncate" | "corrupt" | "replace";

export class Slice8ManualArtifactAdapter {
  readonly #artifacts = new Map<string, Uint8Array>();
  #nextFault: ManualArtifactFault = "none";
  #replacement = new Uint8Array();

  failNext(fault: ManualArtifactFault, replacement = new Uint8Array()): void {
    if (!["none", "permission_denied", "truncate", "corrupt", "replace"].includes(fault)) throw new Error("Unknown manual artifact fault.");
    this.#nextFault = fault;
    this.#replacement = Uint8Array.from(replacement);
  }

  exportExact(operationalName: string, exactEncryptedBytes: Uint8Array): Readonly<{ status: "written"; byte_length: number }> {
    validateName(operationalName);
    const bytes = copyBytes(exactEncryptedBytes);
    if (this.#consumeFault() === "permission_denied") throw new Error("Manual artifact destination denied permission.");
    this.#artifacts.set(operationalName, bytes);
    return Object.freeze({ status: "written", byte_length: bytes.length });
  }

  importExact(operationalName: string): Readonly<{ status: "read"; exact_bytes: Uint8Array }> {
    validateName(operationalName);
    const stored = this.#artifacts.get(operationalName);
    if (!stored) throw new Error("Manual artifact is unavailable.");
    const fault = this.#consumeFault();
    if (fault === "permission_denied") throw new Error("Manual artifact source denied permission.");
    let bytes = Uint8Array.from(stored);
    if (fault === "truncate") bytes = bytes.slice(0, Math.max(0, bytes.length - 1));
    if (fault === "corrupt" && bytes.length > 0) { bytes = Uint8Array.from(bytes); bytes[Math.floor(bytes.length / 2)] ^= 0x01; }
    if (fault === "replace") bytes = Uint8Array.from(this.#replacement);
    return Object.freeze({ status: "read", exact_bytes: bytes });
  }

  duplicate(fromOperationalName: string, toOperationalName: string): void {
    validateName(toOperationalName);
    const source = this.importExact(fromOperationalName).exact_bytes;
    this.#artifacts.set(toOperationalName, Uint8Array.from(source));
  }

  remove(operationalName: string): boolean { validateName(operationalName); return this.#artifacts.delete(operationalName); }
  clear(): void { this.#artifacts.clear(); this.#replacement.fill(0); this.#replacement = new Uint8Array(); this.#nextFault = "none"; }
  artifactCount(): number { return this.#artifacts.size; }

  #consumeFault(): ManualArtifactFault { const value = this.#nextFault; this.#nextFault = "none"; return value; }
}

function copyBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Manual artifacts must be exact opaque bytes.");
  return Uint8Array.from(value);
}
function validateName(value: string): void { if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new Error("Manual artifact operational name is invalid."); }

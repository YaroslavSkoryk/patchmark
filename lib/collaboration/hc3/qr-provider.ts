import encodeQr from "qr";
import decodeQr from "qr/decode.js";
import { parseHc3DirectAuthText } from "./direct-auth.ts";
import { parseHc3ArtifactText } from "./text.ts";
import { hc3CarrierLimits } from "./versions.ts";

export type Hc3QrArtifactKind = "handoff" | "direct";

export type Hc3QrMatrix = Readonly<{
  authority: "none";
  exact_text: string;
  artifact_kind: Hc3QrArtifactKind;
  error_correction: "low";
  encoding: "byte";
  mask: 0;
  border_modules: 4;
  module_count: number;
  cells: readonly (readonly boolean[])[];
}>;

export function renderHc3QrMatrix(input: Readonly<{
  artifact_kind: Hc3QrArtifactKind;
  text: string;
}>): Hc3QrMatrix {
  const exactText = parseEligibleText(input.artifact_kind, input.text);
  const cells = encodeQr(exactText, "raw", {
    ecc: "low",
    encoding: "byte",
    mask: 0,
    border: 4,
    scale: 1
  }).map((row) => Object.freeze(row.map(Boolean)));
  if (!cells.length || cells.some((row) => row.length !== cells.length)) throw new Error("QR provider returned a non-square matrix.");
  return Object.freeze({
    authority: "none",
    exact_text: exactText,
    artifact_kind: input.artifact_kind,
    error_correction: "low",
    encoding: "byte",
    mask: 0,
    border_modules: 4,
    module_count: cells.length,
    cells: Object.freeze(cells)
  });
}

export function decodeHc3QrImage(input: Readonly<{
  artifact_kind: Hc3QrArtifactKind;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}>): string {
  if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1 || input.width * input.height > 16_777_216) {
    throw new Error("QR image dimensions are invalid or oversized.");
  }
  if (!(input.rgba instanceof Uint8ClampedArray) || input.rgba.length !== input.width * input.height * 4) {
    throw new Error("QR image pixels are invalid.");
  }
  const decoded = decodeQr({ width: input.width, height: input.height, data: Uint8ClampedArray.from(input.rgba) });
  return parseEligibleText(input.artifact_kind, decoded);
}

export function parseEligibleHc3QrText(kind: Hc3QrArtifactKind, text: string): string {
  return parseEligibleText(kind, text);
}

function parseEligibleText(kind: Hc3QrArtifactKind, text: string): string {
  if (typeof text !== "string" || text.length > hc3CarrierLimits.maximum_single_qr_characters) {
    throw new Error("Artifact is not eligible for one QR code.");
  }
  return kind === "direct"
    ? parseHc3DirectAuthText(text).text
    : parseHc3ArtifactText(text).text;
}

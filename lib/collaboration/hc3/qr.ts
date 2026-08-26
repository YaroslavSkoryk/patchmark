import { parseHc3ArtifactText, type Hc3ArtifactText } from "./text.ts";
import { hc3CarrierLimits } from "./versions.ts";

export type Hc3QrEligibility = Readonly<{
  authority: "none";
  eligible: boolean;
  character_length: number;
  maximum_single_qr_characters: typeof hc3CarrierLimits.maximum_single_qr_characters;
  fallback: "copy_or_encrypted_file" | null;
}>;

export function assessHc3SingleQrEligibility(value: Hc3ArtifactText): Hc3QrEligibility {
  const parsed = parseHc3ArtifactText(value);
  const eligible = isHc3SingleQrCharacterLengthEligible(parsed.text.length);
  return Object.freeze({
    authority: "none",
    eligible,
    character_length: parsed.text.length,
    maximum_single_qr_characters: hc3CarrierLimits.maximum_single_qr_characters,
    fallback: eligible ? null : "copy_or_encrypted_file"
  });
}

export function isHc3SingleQrCharacterLengthEligible(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("QR character length must be a nonnegative safe integer.");
  return value <= hc3CarrierLimits.maximum_single_qr_characters;
}

export function hc3QrAuthorityNotice(): string {
  return "A QR code is only a visual carrier; it adds no authentication or project authority.";
}

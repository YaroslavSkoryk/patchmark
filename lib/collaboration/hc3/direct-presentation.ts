import type { Hc3DirectAuthText } from "./direct-auth.ts";
import { parseHc3DirectAuthText } from "./direct-auth.ts";
import { hc3CarrierLimits } from "./versions.ts";

export type Hc3DirectConnectionLink = string & { readonly __hc3_direct_link: "connection-link" };

export function createHc3DirectConnectionLink(input: Readonly<{
  base_url: string;
  text: Hc3DirectAuthText;
}>): Hc3DirectConnectionLink {
  parseHc3DirectAuthText(input.text);
  const base = parseBase(input.base_url);
  if (input.text.length > hc3CarrierLimits.maximum_link_payload_characters) throw new Error("HC-3 direct connection text is too large for a link; copy the exact text instead.");
  const separator = base.includes("?") ? "&" : "?";
  const result = `${base}${separator}pmhc3d=${encodeURIComponent(input.text)}`;
  if (result.length > hc3CarrierLimits.maximum_link_characters) throw new Error("HC-3 direct connection link exceeds its Slice 1 limit.");
  return result as Hc3DirectConnectionLink;
}

export function parseHc3DirectConnectionLink(value: unknown): Readonly<{
  link: Hc3DirectConnectionLink;
  text: Hc3DirectAuthText;
}> {
  if (typeof value !== "string" || value.length === 0 || value.length > hc3CarrierLimits.maximum_link_characters) throw new Error("HC-3 direct connection link is empty or oversized.");
  const url = new URL(value);
  const values = url.searchParams.getAll("pmhc3d");
  if (values.length !== 1 || !values[0]) throw new Error("HC-3 direct connection link must contain exactly one artifact.");
  const parsed = parseHc3DirectAuthText(values[0]);
  return Object.freeze({ link: value as Hc3DirectConnectionLink, text: parsed.text });
}

export function assessHc3DirectPresentation(text: Hc3DirectAuthText, baseUrl?: string): Readonly<{
  exact_text_characters: number;
  copy_available: true;
  link_available: boolean;
  single_qr_available: boolean;
  fallback: "copy_exact_text" | null;
}> {
  parseHc3DirectAuthText(text);
  let linkAvailable = text.length <= hc3CarrierLimits.maximum_link_payload_characters;
  if (linkAvailable && baseUrl !== undefined) {
    try { createHc3DirectConnectionLink({ base_url: baseUrl, text }); } catch { linkAvailable = false; }
  }
  const qr = text.length <= hc3CarrierLimits.maximum_single_qr_characters;
  return Object.freeze({
    exact_text_characters: text.length,
    copy_available: true,
    link_available: linkAvailable,
    single_qr_available: qr,
    fallback: linkAvailable && qr ? null : "copy_exact_text"
  });
}

function parseBase(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > hc3CarrierLimits.maximum_base_url_characters) throw new Error("HC-3 direct link base is empty or oversized.");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("HC-3 direct links require HTTPS except for loopback qualification.");
  }
  url.hash = "";
  url.searchParams.delete("pmhc3d");
  return url.toString();
}

import { parseHc3ArtifactText, type Hc3ArtifactText } from "./text.ts";
import { hc3CarrierLimits } from "./versions.ts";
import type { Hc3Carrier } from "./contracts.ts";

declare const hc3HandoffLinkBrand: unique symbol;

export type Hc3HandoffLink = string & {
  readonly [hc3HandoffLinkBrand]: "hc3-handoff-link";
};

export function createHc3FragmentLink(input: Readonly<{
  base_url: string;
  artifact_text: Hc3ArtifactText;
}>): Hc3HandoffLink {
  const base = parseBaseUrl(input.base_url);
  const parsed = parseHc3ArtifactText(input.artifact_text);
  if (parsed.text.length > hc3CarrierLimits.maximum_link_payload_characters) {
    throw new Error("HC-3 artifact is too large for a link fragment; use copy/share or an encrypted file.");
  }
  const link = `${base}#${parsed.text}`;
  if (link.length > hc3CarrierLimits.maximum_link_characters) throw new Error("HC-3 handoff link exceeds its character limit.");
  return link as Hc3HandoffLink;
}

export function parseHc3FragmentLink(input: Readonly<{
  link: string;
  expected_base_url: string;
}>): Readonly<{
  link: Hc3HandoffLink;
  artifact_text: Hc3ArtifactText;
  carrier: Hc3Carrier;
}> {
  if (typeof input.link !== "string" || input.link.length === 0 || input.link.length > hc3CarrierLimits.maximum_link_characters) {
    throw new Error("HC-3 handoff link is empty or exceeds its character limit.");
  }
  const firstHash = input.link.indexOf("#");
  if (firstHash <= 0 || firstHash !== input.link.lastIndexOf("#")) {
    throw new Error("HC-3 handoff link must contain exactly one unambiguous fragment.");
  }
  const expectedBase = parseBaseUrl(input.expected_base_url);
  const suppliedBase = input.link.slice(0, firstHash);
  if (suppliedBase !== expectedBase || suppliedBase.includes("?")) {
    throw new Error("HC-3 handoff payload must not appear in a path or query, and the injected base URL must match exactly.");
  }
  const fragment = input.link.slice(firstHash + 1);
  if (fragment.includes("%") || fragment.length > hc3CarrierLimits.maximum_link_payload_characters) {
    throw new Error("HC-3 handoff fragment is escaped, ambiguous, or oversized.");
  }
  const parsed = parseHc3ArtifactText(fragment);
  const canonicalLink = createHc3FragmentLink({ base_url: expectedBase, artifact_text: parsed.text });
  if (canonicalLink !== input.link) throw new Error("HC-3 handoff link is not canonical.");
  return Object.freeze({ link: canonicalLink, artifact_text: parsed.text, carrier: parsed.carrier });
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > hc3CarrierLimits.maximum_base_url_characters || value.includes("#")) {
    throw new Error("HC-3 base URL is empty, contains a fragment, or exceeds its limit.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("HC-3 base URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("HC-3 handoff links require an HTTPS base without credentials, query parameters, or fragments.");
  }
  return parsed.href;
}

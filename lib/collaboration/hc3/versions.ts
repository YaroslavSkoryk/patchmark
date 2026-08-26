export const HC3_CARRIER_VERSION = 1 as const;
export const HC3_TEXT_VERSION = 1 as const;

export const hc3HandoffArtifactKinds = Object.freeze([
  "invitation_handoff",
  "enrollment_request",
  "possession_proof"
] as const);

export const hc3ConnectionArtifactKinds = Object.freeze([
  "connection_offer",
  "connection_answer"
] as const);

export type Hc3HandoffArtifactKind = (typeof hc3HandoffArtifactKinds)[number];
export type Hc3ConnectionArtifactKind = (typeof hc3ConnectionArtifactKinds)[number];
export type Hc3ArtifactKind = Hc3HandoffArtifactKind | Hc3ConnectionArtifactKind;

export const hc3ArtifactTextTags = Object.freeze({
  invitation_handoff: "ih",
  enrollment_request: "er",
  possession_proof: "pp",
  connection_offer: "co",
  connection_answer: "ca"
} as const satisfies Readonly<Record<Hc3ArtifactKind, string>>);

export const hc3CarrierLimits = Object.freeze({
  maximum_hc2_payload_canonical_bytes: 64 * 1024,
  maximum_connection_description_bytes: 1536,
  maximum_transport_adapter_tag_bytes: 32,
  maximum_carrier_canonical_bytes: 69_632,
  maximum_canonical_text_characters: 93_000,
  maximum_link_payload_characters: 16_384,
  maximum_base_url_characters: 2_048,
  maximum_link_characters: 18_432,
  maximum_single_qr_characters: 2_953
} as const);

export const HC3_TEXT_PREFIX = "pmhc3" as const;
export const HC3_CONNECTION_OFFER_COMMITMENT_DOMAIN =
  "patchmark/hc3/connection-offer-commitment/v1" as const;

export const HC3_ENCRYPTED_BUNDLE_EXTENSION = ".pmcb" as const;
export const HC3_ENCRYPTED_BUNDLE_MEDIA_TYPE =
  "application/vnd.patchmark.collaboration-bundle" as const;

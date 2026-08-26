export const HC3_DIRECT_AUTH_VERSION = 1 as const;
export const HC3_DIRECT_DESCRIPTION_VERSION = 1 as const;
export const HC3_DIRECT_FRAME_VERSION = 1 as const;

export const HC3_DIRECT_ADAPTER_ID = "manual-webrtc-datachannel" as const;
export const HC3_DIRECT_ADAPTER_VERSION = 1 as const;
export const HC3_DIRECT_CHANNEL_LABEL = "patchmark-hc3-v3" as const;
export const HC3_DIRECT_CHANNEL_PROTOCOL = "patchmark/hc3/direct-v3/v1" as const;
export const HC3_DIRECT_TRANSPORT_ADAPTER_TAG_TEXT = "pm-hc3-webrtc-v3-v1" as const;

export function hc3DirectTransportAdapterTag(): Uint8Array {
  return new TextEncoder().encode(HC3_DIRECT_TRANSPORT_ADAPTER_TAG_TEXT);
}

export const HC3_DIRECT_OFFER_SIGNATURE_DOMAIN =
  "patchmark/hc3/direct-connection-offer-signature/v1" as const;
export const HC3_DIRECT_ANSWER_SIGNATURE_DOMAIN =
  "patchmark/hc3/direct-connection-answer-signature/v1" as const;
export const HC3_DIRECT_OFFER_RECORD_COMMITMENT_DOMAIN =
  "patchmark/hc3/direct-connection-offer-record-commitment/v1" as const;

export const hc3DirectLimits = Object.freeze({
  connection_attempt_id_bytes: 16,
  transfer_id_bytes: 16,
  digest_bytes: 32,
  signature_bytes: 64,
  maximum_sdp_utf8_bytes: 1_440,
  maximum_authenticated_record_bytes: 8_192,
  maximum_authenticated_text_characters: 11_000,
  maximum_frame_payload_bytes: 4_096,
  maximum_transfer_bytes: 256 * 1024 * 1024,
  maximum_frame_count: 65_536,
  buffered_amount_high_water: 1,
  buffered_amount_low_water: 0,
  maximum_sync_rounds: 32
} as const);

export const hc3DirectDescriptionKinds = Object.freeze(["offer", "answer"] as const);
export type Hc3DirectDescriptionKind = (typeof hc3DirectDescriptionKinds)[number];

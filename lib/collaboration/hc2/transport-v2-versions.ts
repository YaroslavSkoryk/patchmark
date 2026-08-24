/**
 * HC-2 encrypted transport profile v2.
 *
 * These constants deliberately live outside versions.ts. That module is the
 * frozen v1 registry and must remain byte-for-byte compatible with the HC-2
 * Slice 1 fixtures.
 */
export const HC2_TRANSPORT_PROFILE_VERSION = 2 as const;
export const HC2_TRANSPORT_SCHEMA_VERSION = 2 as const;
export const HC2_TRANSPORT_ENVELOPE_VERSION = 2 as const;
export const HC2_TRANSPORT_PROFILE_ID =
  "patchmark/hc2/encrypted-transport/v2" as const;

export const hc2TransportV2HashDomains = Object.freeze({
  payload: "patchmark/hc2/transport-payload/v2",
  manifest: "patchmark/hc2/bundle-manifest/v2",
  encryptedContainer: "patchmark/hc2/encrypted-container/v2",
  stream: "patchmark/hc2/transport-stream/v2",
  routingTag: "patchmark/hc2/recipient-routing-tag/v2",
  attachment: "patchmark/hc2/transport-attachment/v2",
  attachmentCommitMarker: "patchmark/hc2/transport-attachment-marker/v2",
  attachmentBatch: "patchmark/hc2/transport-attachment-batch/v2"
} as const);

export const hc2TransportV2SignatureDomains = Object.freeze({
  payload: "patchmark/hc2/signature/transport-payload/v2"
} as const);

export const HC2_TRANSPORT_HPKE_INFO_DOMAIN =
  "patchmark/hc2/hpke-info/v2" as const;

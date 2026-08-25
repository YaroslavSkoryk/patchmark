/**
 * HC-2 synchronization transport profile v3.
 *
 * V1 and V2 are frozen. Synchronization therefore has its own versions,
 * domains, identities, payload union, and negotiation surface.
 */
export const HC2_SYNC_TRANSPORT_PROFILE_VERSION = 3 as const;
export const HC2_SYNC_SCHEMA_VERSION = 3 as const;
export const HC2_SYNC_ENVELOPE_VERSION = 3 as const;
export const HC2_SYNC_TRANSPORT_PROFILE_ID =
  "patchmark/hc2/encrypted-synchronization/v3" as const;

export const hc2SyncV3HashDomains = Object.freeze({
  descriptor: "patchmark/hc2/sync/inventory-descriptor/v3",
  inventoryRoot: "patchmark/hc2/sync/inventory-root/v3",
  inventorySnapshot: "patchmark/hc2/sync/inventory-snapshot/v3",
  inventoryPage: "patchmark/hc2/sync/inventory-page/v3",
  session: "patchmark/hc2/sync/session/v3",
  request: "patchmark/hc2/sync/object-request/v3",
  response: "patchmark/hc2/sync/object-response/v3",
  confirmation: "patchmark/hc2/sync/confirmation/v3",
  payload: "patchmark/hc2/sync/transport-payload/v3",
  manifest: "patchmark/hc2/sync/bundle-manifest/v3",
  encryptedContainer: "patchmark/hc2/sync/encrypted-container/v3",
  stream: "patchmark/hc2/sync/transport-stream/v3",
  routingTag: "patchmark/hc2/sync/recipient-routing-tag/v3"
} as const);

export const hc2SyncV3SignatureDomains = Object.freeze({
  payload: "patchmark/hc2/signature/synchronization-payload/v3"
} as const);

export const HC2_SYNC_HPKE_INFO_DOMAIN =
  "patchmark/hc2/synchronization-hpke-info/v3" as const;

/** Per explicit invocation. No function in Slice 7 loops beyond these bounds. */
export const hc2SyncInvocationLimits = Object.freeze({
  maximum_descriptors_per_page: 128,
  maximum_page_canonical_bytes: BigInt(1024 * 1024),
  maximum_pages_processed: 4,
  maximum_request_items: 64,
  maximum_requests_processed: 4,
  maximum_objects_returned: 64,
  maximum_response_object_bytes: BigInt(16 * 1024 * 1024),
  maximum_bytes_read: BigInt(64 * 1024 * 1024),
  maximum_bytes_written: BigInt(64 * 1024 * 1024),
  maximum_containers_decrypted: 16,
  maximum_dependency_depth: 256,
  maximum_messages_processed: 16,
  maximum_session_rounds: 32
} as const);

export const hc2SyncV3PayloadKinds = Object.freeze([
  "bundle_manifest",
  "sync_offer",
  "inventory_page",
  "object_request",
  "object_response",
  "sync_confirmation",
  "hc1_object_chunk",
  "admission_attachment",
  "epoch_delivery_attachment",
  "receipt_attachment"
] as const);

export type SyncMessageRoleV3 =
  | "initiator_to_responder"
  | "responder_to_initiator";

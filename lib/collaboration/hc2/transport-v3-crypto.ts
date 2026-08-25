import { canonicalArray, canonicalBytes, canonicalText, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import { sha256, type Sha256Provider } from "../sha256.ts";
import type { AlgorithmTaggedPublicKeyBytes, RandomSource, X25519RecipientKeyPairHandle } from "./crypto-contracts.ts";
import { parseEnvelopeId } from "./identities.ts";
import type { RecipientTransportEnvelopeProviderV3 } from "./providers/hpke-v3-provider.ts";
import {
  buildTransportSignaturePreimageV3,
  createEncryptedContainerRecordV3,
  decodeSignedPlaintextRecordV3,
  deriveBundleManifestIdentityV3,
  deriveTransportPayloadIdentityV3,
  encodeSignedPlaintextRecordV3,
  parseBundleManifestCoreV3,
  parseSignedPlaintextCoreV3,
  parseTransportBindingCommonV3,
  parseTransportPayloadCoreV3,
  type BundleManifestPayloadV3,
  type EncryptedContainerRecordV3,
  type PublicEnvelopeHeaderV3,
  type SignedPlaintextCoreV3,
  type SignedPlaintextRecordV3,
  type TransportBindingCommonV3,
  type TransportPayloadCoreV3,
  type TransportSignaturePreimageBytesV3
} from "./transport-v3-contracts.ts";
import {
  deriveSyncV3Identity,
  type BundleManifestIdV3,
  type SyncSessionIdV3,
  type TransportStreamIdV3
} from "./sync-v3-identities.ts";
import { HC2_SYNC_ENVELOPE_VERSION, HC2_SYNC_SCHEMA_VERSION, HC2_SYNC_TRANSPORT_PROFILE_ID, hc2SyncV3HashDomains } from "./sync-v3-versions.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "./versions.ts";

export interface TransportSignatureV3Provider {
  sign(preimage: TransportSignaturePreimageBytesV3): Promise<Uint8Array>;
  verify(input: Readonly<{ core: SignedPlaintextCoreV3; preimage: TransportSignaturePreimageBytesV3; signature_bytes: Uint8Array }>): Promise<boolean>;
}

export type SyncExportAuthorityDecisionV3 =
  | Readonly<{ status: "accepted"; epoch_key_available: true }>
  | Readonly<{ status: "stale_authority" | "stale_epoch" | "revoked" | "rejected"; reason: string }>;

export interface SyncTransportExportAuthorityV3 {
  /** Re-resolves accepted state before every explicit outbound operation. */
  verify(input: Readonly<{
    common_binding: TransportBindingCommonV3;
    payloads: readonly Exclude<TransportPayloadCoreV3, BundleManifestPayloadV3>[];
    recipient_public_key: AlgorithmTaggedPublicKeyBytes;
  }>): Promise<SyncExportAuthorityDecisionV3>;
}

declare const preparedTransportBundleV3Brand: unique symbol;
export type PreparedTransportBundleV3 = Readonly<{
  readonly [preparedTransportBundleV3Brand]: true;
  manifest_id: BundleManifestIdV3;
  containers: readonly EncryptedContainerRecordV3[];
  payloads: readonly TransportPayloadCoreV3[];
}>;

export type PrepareTransportBundleResultV3 =
  | Readonly<{ status: "prepared"; bundle: PreparedTransportBundleV3 }>
  | Readonly<{ status: "stale_authority" | "stale_epoch" | "revoked" | "rejected"; reason: string }>;

export async function deriveSyncSessionIdV3(value: Readonly<{
  project_id: TransportBindingCommonV3["project_id"];
  initiator_device_id: TransportBindingCommonV3["sender_device_id"];
  responder_device_id: TransportBindingCommonV3["recipient_device_id"];
  session_generation: TransportBindingCommonV3["session_generation"];
}>): Promise<SyncSessionIdV3> {
  return (await deriveSyncV3Identity("sync-session", canonicalProtocolValue(Object.freeze({ transport_profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID, ...value })))).id;
}

export async function deriveTransportStreamIdV3(value: Readonly<{
  project_id: TransportBindingCommonV3["project_id"];
  sender_device_id: TransportBindingCommonV3["sender_device_id"];
  recipient_device_id: TransportBindingCommonV3["recipient_device_id"];
  session_id: TransportBindingCommonV3["session_id"];
  stream_generation: TransportBindingCommonV3["stream_generation"];
}>): Promise<TransportStreamIdV3> {
  return (await deriveSyncV3Identity("transport-stream", canonicalProtocolValue(Object.freeze({ transport_profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID, purpose: "synchronization", ...value })))).id;
}

export async function deriveRecipientRoutingTagV3(recipientPublicKey: AlgorithmTaggedPublicKeyBytes, envelopeId: string, provider?: Sha256Provider): Promise<Uint8Array> {
  return Uint8Array.from(await sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2SyncV3HashDomains.routingTag),
    canonicalBytes(recipientPublicKey),
    canonicalText(parseEnvelopeId(envelopeId))
  ])), provider));
}

export async function prepareEncryptedTransportBundleV3(input: Readonly<{
  common_binding: TransportBindingCommonV3;
  non_manifest_payloads: readonly Exclude<TransportPayloadCoreV3, BundleManifestPayloadV3>[];
  recipient_public_key: AlgorithmTaggedPublicKeyBytes;
  authority: SyncTransportExportAuthorityV3;
  random: RandomSource;
  signatures: TransportSignatureV3Provider;
  hpke: RecipientTransportEnvelopeProviderV3;
  sha256_provider?: Sha256Provider;
}>): Promise<PrepareTransportBundleResultV3> {
  const common = parseTransportBindingCommonV3(input.common_binding);
  if (!Array.isArray(input.non_manifest_payloads) || input.non_manifest_payloads.length === 0 || input.non_manifest_payloads.length + 1 !== common.payload_count) throw new Error("V3 payload selection must exactly match the common binding count.");
  const logicalPayloads = Object.freeze(input.non_manifest_payloads.map((entry) => {
    const parsed = parseTransportPayloadCoreV3(entry);
    if (parsed.payload_kind === "bundle_manifest") throw new Error("V3 manifest is derived internally.");
    assertPayloadSessionBinding(common, parsed);
    return parsed;
  }));

  // This is intentionally the first call capable of authorizing output.
  const authority = await input.authority.verify({ common_binding: common, payloads: logicalPayloads, recipient_public_key: Uint8Array.from(input.recipient_public_key) as AlgorithmTaggedPublicKeyBytes });
  if (authority.status !== "accepted") return Object.freeze({ status: authority.status, reason: authority.reason });
  if (authority.epoch_key_available !== true) throw new Error("Accepted V3 export authority must prove current epoch-key availability.");

  const identified = [];
  for (const payload of logicalPayloads) identified.push(await deriveTransportPayloadIdentityV3(payload, input.sha256_provider));
  const manifestCore = parseBundleManifestCoreV3({
    schema_version: HC2_SYNC_SCHEMA_VERSION,
    record_kind: "bundle_manifest_core_v3",
    transport_profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID,
    common_binding: common,
    payload_descriptors: identified.map((entry, index) => ({ payload_kind: entry.payload.payload_kind, payload_ordinal: index + 1, payload_id: entry.payload_id, canonical_length: entry.canonical_length }))
  });
  const manifestId = await deriveBundleManifestIdentityV3(manifestCore, input.sha256_provider);
  const manifestPayload: BundleManifestPayloadV3 = Object.freeze({ schema_version: HC2_SYNC_SCHEMA_VERSION, payload_kind: "bundle_manifest", manifest_core: manifestCore });
  const payloads: readonly TransportPayloadCoreV3[] = Object.freeze([manifestPayload, ...identified.map((entry) => entry.payload)]);
  const envelopeId = await randomEnvelopeId(input.random);
  const routingTag = await deriveRecipientRoutingTagV3(input.recipient_public_key, envelopeId, input.sha256_provider);
  const containers: EncryptedContainerRecordV3[] = [];
  for (let ordinal = 0; ordinal < payloads.length; ordinal += 1) {
    const payload = payloads[ordinal];
    const core = parseSignedPlaintextCoreV3({
      schema_version: HC2_SYNC_SCHEMA_VERSION,
      record_kind: "signed_plaintext_core_v3",
      binding: { schema_version: HC2_SYNC_SCHEMA_VERSION, record_kind: "transport_binding_core_v3", ...common, bundle_manifest_id: manifestId, payload_kind: payload.payload_kind, payload_ordinal: ordinal },
      payload
    });
    const signature = Uint8Array.from(await input.signatures.sign(buildTransportSignaturePreimageV3(core)));
    if (signature.length !== 64) throw new Error("V3 signature provider returned a non-Ed25519 signature.");
    const signed: SignedPlaintextRecordV3 = Object.freeze({ record_version: HC2_SYNC_SCHEMA_VERSION, record_kind: "signed_plaintext_record_v3", core, signature_algorithm: "ed25519", signature_bytes: signature });
    const plaintext = encodeSignedPlaintextRecordV3(signed);
    const infoBinding = Object.freeze({ magic: HC2_ENVELOPE_MAGIC, envelope_version: HC2_SYNC_ENVELOPE_VERSION, suite_id: HC2_CRYPTO_SUITE_ID, envelope_id: envelopeId, recipient_routing_tag: Uint8Array.from(routingTag), chunk_ordinal: ordinal, chunk_count: payloads.length });
    const sealed = await input.hpke.sealBound({
      recipient_public_key: input.recipient_public_key,
      info_binding: infoBinding,
      plaintext,
      finalize_header: (enc, length) => Object.freeze({ ...infoBinding, encapsulated_key_bytes: Uint8Array.from(enc), ciphertext_length: length as PublicEnvelopeHeaderV3["ciphertext_length"] })
    });
    containers.push(await createEncryptedContainerRecordV3({ schema_version: HC2_SYNC_SCHEMA_VERSION, record_kind: "encrypted_container_core_v3", public_header: sealed.public_header, ciphertext_bytes: sealed.ciphertext_bytes }, input.sha256_provider));
  }
  const bundle = Object.freeze({ manifest_id: manifestId, containers: Object.freeze(containers), payloads }) as PreparedTransportBundleV3;
  return Object.freeze({ status: "prepared", bundle });
}

export async function openEncryptedTransportContainerV3(input: Readonly<{
  container: EncryptedContainerRecordV3;
  recipient_key_pair: X25519RecipientKeyPairHandle;
  signatures: TransportSignatureV3Provider;
  hpke: RecipientTransportEnvelopeProviderV3;
}>): Promise<Readonly<{ status: "opened"; signed: SignedPlaintextRecordV3 }> | Readonly<{ status: "rejected"; reason: "authentication_failed" | "malformed" | "invalid_signature" | "binding_mismatch" }>> {
  const opened = await input.hpke.openBound({ recipient_key_pair: input.recipient_key_pair, public_header: input.container.core.public_header, ciphertext_bytes: input.container.core.ciphertext_bytes });
  if (opened.status === "rejected") return Object.freeze({ status: "rejected", reason: opened.reason });
  let signed: SignedPlaintextRecordV3;
  try { signed = decodeSignedPlaintextRecordV3(opened.plaintext); }
  catch { return Object.freeze({ status: "rejected", reason: "malformed" }); }
  finally { opened.plaintext.fill(0); }
  const header = input.container.core.public_header;
  if (signed.core.binding.payload_ordinal !== header.chunk_ordinal || signed.core.binding.payload_count !== header.chunk_count) return Object.freeze({ status: "rejected", reason: "binding_mismatch" });
  if (!(await input.signatures.verify({ core: signed.core, preimage: buildTransportSignaturePreimageV3(signed.core), signature_bytes: signed.signature_bytes }))) return Object.freeze({ status: "rejected", reason: "invalid_signature" });
  return Object.freeze({ status: "opened", signed });
}

function assertPayloadSessionBinding(common: TransportBindingCommonV3, payload: Exclude<TransportPayloadCoreV3, BundleManifestPayloadV3>): void {
  const core = payload.payload_kind === "sync_offer" ? payload.offer_core
    : payload.payload_kind === "inventory_page" ? payload.page_core
    : payload.payload_kind === "object_request" ? payload.request_core
    : payload.payload_kind === "object_response" ? payload.response_core
    : payload.payload_kind === "sync_confirmation" ? payload.confirmation_core
    : null;
  if (core && (core.session_id !== common.session_id || core.session_generation !== common.session_generation || core.round_number !== common.round_number)) throw new Error("V3 payload session or round differs from its signed transport binding.");
}

async function randomEnvelopeId(random: RandomSource): Promise<ReturnType<typeof parseEnvelopeId>> {
  const bytes = Uint8Array.from(await random.randomBytes(16));
  if (bytes.length !== 16) throw new Error("Random source returned an invalid V3 envelope identity.");
  return parseEnvelopeId(encodeBase32(bytes));
}

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
function encodeBase32(bytes: Uint8Array): string {
  let output = "", accumulator = 0, bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(accumulator >>> bits) & 31]; accumulator &= (1 << bits) - 1; }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

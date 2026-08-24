import { canonicalArray, canonicalBytes, canonicalText, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  RandomSource,
  X25519RecipientKeyPairHandle
} from "./crypto-contracts.ts";
import { parseEnvelopeId } from "./identities.ts";
import type { Sha256Provider } from "../sha256.ts";
import { sha256 } from "../sha256.ts";
import {
  buildTransportSignaturePreimageV2,
  createEncryptedContainerRecordV2,
  decodeSignedPlaintextRecordV2,
  deriveBundleManifestIdentityV2,
  deriveTransportPayloadIdentityV2,
  encodeSignedPlaintextRecordV2,
  parseBundleManifestCoreV2,
  parseSignedPlaintextCoreV2,
  parseTransportBindingCommonV2,
  parseTransportPayloadCoreV2,
  type BundleManifestPayloadV2,
  type EncryptedContainerRecordV2,
  type NonManifestTransportPayloadKindV2,
  type SignedPlaintextCoreV2,
  type SignedPlaintextRecordV2,
  type TransportBindingCommonV2,
  type TransportPayloadCoreV2,
  type TransportSignaturePreimageBytesV2
} from "./transport-v2-contracts.ts";
import type { RecipientTransportEnvelopeProviderV2 } from "./providers/hpke-v2-provider.ts";
import {
  deriveTransportV2Identity,
  type BundleManifestIdV2,
  type TransportStreamIdV2
} from "./transport-v2-identities.ts";
import {
  HC2_TRANSPORT_ENVELOPE_VERSION,
  HC2_TRANSPORT_PROFILE_ID,
  HC2_TRANSPORT_SCHEMA_VERSION,
  hc2TransportV2HashDomains
} from "./transport-v2-versions.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "./versions.ts";

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

export interface TransportSignatureV2Provider {
  sign(preimage: TransportSignaturePreimageBytesV2): Promise<Uint8Array>;
  verify(input: Readonly<{
    core: SignedPlaintextCoreV2;
    preimage: TransportSignaturePreimageBytesV2;
    signature_bytes: Uint8Array;
  }>): Promise<boolean>;
}

export interface TransportExportAuthorityV2 {
  /**
   * Resolves the bound sender, recipient key, accepted control head, revocation
   * state, and locally wrapped current epoch before any cryptographic output is
   * created. Portable evidence never grants this authority by itself.
   */
  verify(input: Readonly<{
    common_binding: TransportBindingCommonV2;
    payloads: readonly Exclude<TransportPayloadCoreV2, BundleManifestPayloadV2>[];
    recipient_public_key: AlgorithmTaggedPublicKeyBytes;
  }>): Promise<
    | Readonly<{ status: "accepted"; epoch_key_available: true }>
    | Readonly<{ status: "rejected"; reason: string }>
  >;
}

declare const preparedTransportBundleV2Brand: unique symbol;
export type PreparedTransportBundleV2 = Readonly<{
  readonly [preparedTransportBundleV2Brand]: true;
  manifest_id: BundleManifestIdV2;
  containers: readonly EncryptedContainerRecordV2[];
  payloads: readonly TransportPayloadCoreV2[];
}>;

export async function deriveTransportStreamIdV2(
  value: Readonly<{
    project_id: TransportBindingCommonV2["project_id"];
    purpose: TransportBindingCommonV2["purpose"];
    sender_person_id: TransportBindingCommonV2["sender_person_id"];
    sender_membership_id: TransportBindingCommonV2["sender_membership_id"];
    sender_device_id: TransportBindingCommonV2["sender_device_id"];
    recipient_person_id: TransportBindingCommonV2["recipient_person_id"];
    recipient_membership_id: TransportBindingCommonV2["recipient_membership_id"];
    recipient_device_id: TransportBindingCommonV2["recipient_device_id"];
    recipient_key_id: TransportBindingCommonV2["recipient_key_id"];
    stream_generation: TransportBindingCommonV2["stream_generation"];
  }>,
  provider?: Sha256Provider
): Promise<TransportStreamIdV2> {
  const identity = await deriveTransportV2Identity(
    "transport-stream",
    canonicalProtocolValue(Object.freeze({
      transport_profile_id: HC2_TRANSPORT_PROFILE_ID,
      ...value
    })),
    provider
  );
  return identity.id;
}

export async function deriveRecipientRoutingTagV2(
  recipientPublicKey: AlgorithmTaggedPublicKeyBytes,
  envelopeId: string,
  provider?: Sha256Provider
): Promise<Uint8Array> {
  if (!(recipientPublicKey instanceof Uint8Array) || recipientPublicKey.length === 0) {
    throw new Error("Recipient routing requires an encoded recipient public key.");
  }
  const parsedEnvelope = parseEnvelopeId(envelopeId);
  return Uint8Array.from(await sha256(
    encodeRoutingPreimage(recipientPublicKey, parsedEnvelope),
    provider
  ));
}

export async function prepareEncryptedTransportBundleV2(input: Readonly<{
  common_binding: TransportBindingCommonV2;
  non_manifest_payloads: readonly Exclude<TransportPayloadCoreV2, BundleManifestPayloadV2>[];
  recipient_public_key: AlgorithmTaggedPublicKeyBytes;
  authority: TransportExportAuthorityV2;
  random: RandomSource;
  signatures: TransportSignatureV2Provider;
  hpke: RecipientTransportEnvelopeProviderV2;
  sha256_provider?: Sha256Provider;
}>): Promise<PreparedTransportBundleV2> {
  const common = parseTransportBindingCommonV2(input.common_binding);
  if (!Array.isArray(input.non_manifest_payloads) || input.non_manifest_payloads.length === 0 || input.non_manifest_payloads.length + 1 !== common.payload_count) {
    throw new Error("Transport payload selection must exactly match the common binding count.");
  }
  const logicalPayloads = Object.freeze(input.non_manifest_payloads.map((value) => {
    const payload = parseTransportPayloadCoreV2(value);
    if (payload.payload_kind === "bundle_manifest") throw new Error("The encrypted transport manifest is derived internally.");
    return payload;
  }));
  assertPurposePayloadSet(common.purpose, logicalPayloads);
  const authorized = await input.authority.verify({
    common_binding: common,
    payloads: logicalPayloads,
    recipient_public_key: Uint8Array.from(input.recipient_public_key) as AlgorithmTaggedPublicKeyBytes
  });
  if (authorized.status !== "accepted" || authorized.epoch_key_available !== true) {
    throw new Error("Transport export authority rejected before cryptographic preparation.");
  }
  const identified = [];
  for (const payload of logicalPayloads) {
    identified.push(await deriveTransportPayloadIdentityV2(payload, input.sha256_provider));
  }
  const manifestCore = parseBundleManifestCoreV2({
    schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
    record_kind: "bundle_manifest_core_v2",
    transport_profile_id: HC2_TRANSPORT_PROFILE_ID,
    common_binding: common,
    payload_descriptors: identified.map((entry, index) => ({
      payload_kind: entry.payload.payload_kind,
      payload_ordinal: index + 1,
      payload_id: entry.payload_id,
      canonical_length: entry.canonical_length
    }))
  });
  const manifestIdentity = await deriveBundleManifestIdentityV2(manifestCore, input.sha256_provider);
  const manifestPayload: BundleManifestPayloadV2 = Object.freeze({
    schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
    payload_kind: "bundle_manifest",
    manifest_core: manifestCore
  });
  const payloads: readonly TransportPayloadCoreV2[] = Object.freeze([
    manifestPayload,
    ...identified.map((entry) => entry.payload)
  ]);
  const envelopeId = await randomEnvelopeId(input.random);
  const routingTag = await deriveRecipientRoutingTagV2(input.recipient_public_key, envelopeId, input.sha256_provider);
  const containers: EncryptedContainerRecordV2[] = [];
  for (let ordinal = 0; ordinal < payloads.length; ordinal += 1) {
    const payload = payloads[ordinal];
    const core = parseSignedPlaintextCoreV2({
      schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "signed_plaintext_core_v2",
      binding: {
        schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
        record_kind: "transport_binding_core_v2",
        ...common,
        bundle_manifest_id: manifestIdentity.manifest_id,
        payload_kind: payload.payload_kind,
        payload_ordinal: ordinal
      },
      payload
    });
    const signature = Uint8Array.from(await input.signatures.sign(buildTransportSignaturePreimageV2(core)));
    if (signature.length !== 64) throw new Error("Transport signature provider returned a non-Ed25519 signature.");
    const signed: SignedPlaintextRecordV2 = Object.freeze({
      record_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "signed_plaintext_record_v2",
      core,
      signature_algorithm: "ed25519",
      signature_bytes: signature
    });
    const plaintext = encodeSignedPlaintextRecordV2(signed);
    const infoBinding = Object.freeze({
      magic: HC2_ENVELOPE_MAGIC,
      envelope_version: HC2_TRANSPORT_ENVELOPE_VERSION,
      suite_id: HC2_CRYPTO_SUITE_ID,
      envelope_id: envelopeId,
      recipient_routing_tag: Uint8Array.from(routingTag),
      chunk_ordinal: ordinal,
      chunk_count: payloads.length
    });
    const sealed = await input.hpke.sealBound({
      recipient_public_key: input.recipient_public_key,
      info_binding: infoBinding,
      plaintext,
      finalize_header: (enc, ciphertextLength) => Object.freeze({
        ...infoBinding,
        encapsulated_key_bytes: Uint8Array.from(enc),
        ciphertext_length: ciphertextLength as PublicHeaderCiphertextLength
      })
    });
    containers.push(await createEncryptedContainerRecordV2({
      schema_version: HC2_TRANSPORT_SCHEMA_VERSION,
      record_kind: "encrypted_container_core_v2",
      public_header: sealed.public_header,
      ciphertext_bytes: sealed.ciphertext_bytes
    }, input.sha256_provider));
  }
  return Object.freeze({
    manifest_id: manifestIdentity.manifest_id,
    containers: Object.freeze(containers),
    payloads
  }) as PreparedTransportBundleV2;
}

type PublicHeaderCiphertextLength = import("../validation.ts").UInt64;

export async function openEncryptedTransportContainerV2(input: Readonly<{
  container: EncryptedContainerRecordV2;
  recipient_key_pair: X25519RecipientKeyPairHandle;
  signatures: TransportSignatureV2Provider;
  hpke: RecipientTransportEnvelopeProviderV2;
}>): Promise<
  | Readonly<{ status: "opened"; signed: SignedPlaintextRecordV2 }>
  | Readonly<{ status: "rejected"; reason: "authentication_failed" | "malformed" | "invalid_signature" | "binding_mismatch" }>
> {
  const opened = await input.hpke.openBound({
    recipient_key_pair: input.recipient_key_pair,
    public_header: input.container.core.public_header,
    ciphertext_bytes: input.container.core.ciphertext_bytes
  });
  if (opened.status === "rejected") return Object.freeze({ status: "rejected", reason: opened.reason === "malformed" ? "malformed" : "authentication_failed" });
  let signed: SignedPlaintextRecordV2;
  try {
    signed = decodeSignedPlaintextRecordV2(opened.plaintext);
  } catch {
    return Object.freeze({ status: "rejected", reason: "malformed" });
  } finally {
    opened.plaintext.fill(0);
  }
  const header = input.container.core.public_header;
  if (signed.core.binding.payload_ordinal !== header.chunk_ordinal || signed.core.binding.payload_count !== header.chunk_count) {
    return Object.freeze({ status: "rejected", reason: "binding_mismatch" });
  }
  if (!(await input.signatures.verify({
    core: signed.core,
    preimage: buildTransportSignaturePreimageV2(signed.core),
    signature_bytes: signed.signature_bytes
  }))) {
    return Object.freeze({ status: "rejected", reason: "invalid_signature" });
  }
  return Object.freeze({ status: "opened", signed });
}

function assertPurposePayloadSet(purpose: TransportBindingCommonV2["purpose"], payloads: readonly Exclude<TransportPayloadCoreV2, BundleManifestPayloadV2>[]): void {
  const kinds = payloads.map((entry) => entry.payload_kind as NonManifestTransportPayloadKindV2);
  if (purpose === "admission") {
    for (const required of ["admission_attachment", "epoch_delivery_attachment"] as const) {
      if (kinds.filter((entry) => entry === required).length !== 1) throw new Error(`Admission transport requires exactly one ${required}.`);
    }
  } else if (kinds.includes("admission_attachment") || kinds.includes("epoch_delivery_attachment")) {
    throw new Error("Replication transport cannot carry admission-only attachments.");
  }
}

async function randomEnvelopeId(random: RandomSource): Promise<ReturnType<typeof parseEnvelopeId>> {
  const bytes = Uint8Array.from(await random.randomBytes(16));
  if (bytes.length !== 16) throw new Error("Random source returned an invalid envelope identifier.");
  return parseEnvelopeId(encodeBase32(bytes));
}

function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += base32Alphabet[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += base32Alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

function encodeRoutingPreimage(recipientPublicKey: Uint8Array, envelopeId: string): Uint8Array {
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2TransportV2HashDomains.routingTag),
    canonicalBytes(Uint8Array.from(recipientPublicKey)),
    canonicalText(envelopeId)
  ]));
}

import { encodeSha256Base32 } from "../base32.ts";
import { decodeCanonicalCbor, encodeCanonicalCbor, canonicalArray, canonicalBytes, canonicalText } from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import { sha256 } from "../sha256.ts";
import type { ControlEventId, DeviceId, ProjectId } from "../identities.ts";
import { parseDigestId, parseEntityId } from "../identities.ts";
import type { HpkeCiphertextBytes, RandomSource, RecipientEnvelopeProvider } from "./crypto-contracts.ts";
import {
  buildEnrollmentSignaturePreimage,
  deriveEnrollmentRequestIdentity,
  deriveDeliverySetIdentity,
  deriveEpochDeliveryIdentity,
  deriveMembershipTransitionIdentity,
  derivePossessionChallengeIdentity,
  derivePossessionProofIdentity,
  deriveRecipientManifestIdentity,
  digestEnrollmentHeader,
  digestPublicKeyBytes,
  parseEnrollmentRequestRecord,
  parseDeliverySetCore,
  parseEpochDeliveryEnvelope,
  parseEpochDeliveryHeaderCore,
  parseEpochDeliveryPlaintext,
  parsePossessionChallengeEnvelope,
  parsePossessionChallengeHeaderCore,
  parsePossessionProofRecord,
  parsePossessionResponseCore,
  parseMembershipTransitionCore,
  parseRecipientManifestCore,
  type EnrollmentRequestRecord,
  type DeliverySetCore,
  type EpochDeliveryEnvelope,
  type EpochDeliveryHeaderCore,
  type EpochDeliveryPlaintext,
  type PossessionChallengeEnvelope,
  type PossessionChallengeHeaderCore,
  type PossessionProofRecord,
  type MembershipTransitionCore,
  type RecipientManifestCore
} from "./enrollment-contracts.ts";
import { buildBoundHpkeAad, buildHpkeInfo, type PublicEnvelopeHeader } from "./envelope.ts";
import { parseEnvelopeId } from "./identities.ts";
import { importEncodedPublicKey } from "./providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "./versions.ts";

const challengeCommitmentDomain = "patchmark/hc2/possession-challenge-commitment/v1";
const challengeResponseDomain = "patchmark/hc2/possession-challenge-response/v1";

export type PreparedPossessionChallenge = Readonly<{
  envelope: PossessionChallengeEnvelope;
  expected_response_sha256: Uint8Array;
}>;

export async function verifyEnrollmentRequestSignature(input: Readonly<{
  request: EnrollmentRequestRecord;
  subtle?: SubtleCrypto;
}>): Promise<boolean> {
  try {
    const request = parseEnrollmentRequestRecord(input.request);
    const identity = await deriveEnrollmentRequestIdentity(request.core);
    if (identity.id !== request.request_id) return false;
    const imported = await importEncodedPublicKey({ subtle: input.subtle ?? requireSubtle(), encoded: request.core.signing_public_key_bytes, expected_algorithm: "ed25519" });
    if (imported.key_id !== request.core.signing_key_id) return false;
    return (input.subtle ?? requireSubtle()).verify("Ed25519", imported.public_key, asArrayBuffer(request.signature_bytes), asArrayBuffer(buildEnrollmentSignaturePreimage("enrollment_request", request.core.project_id, request.request_id)));
  } catch { return false; }
}

export async function createPossessionChallenge(input: Readonly<{
  request: EnrollmentRequestRecord;
  current_control_head_id: ControlEventId;
  random: RandomSource;
  hpke: RecipientEnvelopeProvider;
}>): Promise<PreparedPossessionChallenge> {
  const request = parseEnrollmentRequestRecord(input.request);
  if (!(await verifyEnrollmentRequestSignature({ request }))) throw new Error("Enrollment request signature is invalid.");
  const controlHead = parseDigestId("control-event", input.current_control_head_id);
  if (request.core.bound_control_head_id !== controlHead) throw new Error("Enrollment request is stale at the current control head.");
  const plaintext = Uint8Array.from(await input.random.randomBytes(32));
  if (plaintext.length !== 32) throw new Error("Random provider returned an invalid possession challenge.");
  try {
    const [commitment, response, signingDigest, recipientDigest] = await Promise.all([
      domainHash(challengeCommitmentDomain, plaintext),
      domainHash(challengeResponseDomain, plaintext),
      digestPublicKeyBytes(request.core.signing_public_key_bytes),
      digestPublicKeyBytes(request.core.recipient_public_key_bytes)
    ]);
    const headerCore = parsePossessionChallengeHeaderCore({
      schema_version: 1,
      record_kind: "possession_challenge_header_core",
      authority: "none",
      project_id: request.core.project_id,
      invitation_id: request.core.invitation_id,
      request_id: request.request_id,
      candidate_person_id: request.core.candidate_person_id,
      candidate_device_id: request.core.candidate_device_id,
      signing_key_id: request.core.signing_key_id,
      recipient_key_id: request.core.recipient_key_id,
      signing_public_key_sha256: signingDigest,
      recipient_public_key_sha256: recipientDigest,
      challenge_commitment: commitment,
      bound_control_head_id: controlHead,
      suite_id: HC2_CRYPTO_SUITE_ID
    });
    const challengeIdentity = await derivePossessionChallengeIdentity(headerCore);
    const routingTag = await digestEnrollmentHeader(headerCore);
    const binding = envelopeBinding(routingTag, challengeIdentity.digest);
    const info = buildHpkeInfo(binding);
    let publicHeader: PublicEnvelopeHeader | null = null;
    const sealed = await input.hpke.sealBound({
      recipient_public_key: request.core.recipient_public_key_bytes,
      info,
      plaintext,
      finalize_aad(encapsulatedKeyBytes) {
        publicHeader = {
          magic: HC2_ENVELOPE_MAGIC,
          ...binding,
          encapsulated_key_bytes: Uint8Array.from(encapsulatedKeyBytes),
          ciphertext_length: BigInt(plaintext.length + 16)
        };
        return buildBoundHpkeAad(publicHeader);
      }
    });
    if (!publicHeader) throw new Error("HPKE challenge header was not finalized.");
    return Object.freeze({
      envelope: parsePossessionChallengeEnvelope({ record_version: 1, record_kind: "possession_challenge_envelope", authority: "none", challenge_id: challengeIdentity.id, header_core: headerCore, public_header: publicHeader, ciphertext_bytes: sealed.ciphertext_bytes }),
      expected_response_sha256: Uint8Array.from(response)
    });
  } finally { plaintext.fill(0); }
}

export async function buildPossessionResponse(input: Readonly<{
  envelope: PossessionChallengeEnvelope;
  request: EnrollmentRequestRecord;
  open: (input: Readonly<{ info: ReturnType<typeof buildHpkeInfo>; public_header: PublicEnvelopeHeader; ciphertext_bytes: HpkeCiphertextBytes }>) => Promise<Readonly<{ status: "opened"; plaintext: Uint8Array }> | Readonly<{ status: "rejected" }>>;
  sign: (preimage: ReturnType<typeof buildEnrollmentSignaturePreimage>) => Promise<Uint8Array>;
}>): Promise<PossessionProofRecord> {
  const envelope = parsePossessionChallengeEnvelope(input.envelope); const request = parseEnrollmentRequestRecord(input.request);
  const challengeIdentity = await derivePossessionChallengeIdentity(envelope.header_core); if (challengeIdentity.id !== envelope.challenge_id) throw new Error("Possession challenge identity mismatch.");
  assertChallengeRequestBinding(envelope.header_core, request);
  const routingTag = await digestEnrollmentHeader(envelope.header_core); if (!sameBytes(routingTag, envelope.public_header.recipient_routing_tag)) throw new Error("Possession challenge AAD commitment is invalid.");
  const opened = await input.open({ info: buildHpkeInfo(envelope.public_header), public_header: envelope.public_header, ciphertext_bytes: envelope.ciphertext_bytes as HpkeCiphertextBytes });
  if (opened.status !== "opened") throw new Error("Possession challenge authentication failed.");
  const plaintext = Uint8Array.from(opened.plaintext);
  try {
    if (plaintext.length !== 32 || !sameBytes(await domainHash(challengeCommitmentDomain, plaintext), envelope.header_core.challenge_commitment)) throw new Error("Possession challenge plaintext does not match its header commitment.");
    const core = parsePossessionResponseCore({ schema_version: 1, record_kind: "possession_response_core", authority: "none", project_id: request.core.project_id, invitation_id: request.core.invitation_id, request_id: request.request_id, challenge_id: envelope.challenge_id, challenge_commitment: envelope.header_core.challenge_commitment, challenge_response: await domainHash(challengeResponseDomain, plaintext), candidate_person_id: request.core.candidate_person_id, candidate_device_id: request.core.candidate_device_id, signing_key_id: request.core.signing_key_id, recipient_key_id: request.core.recipient_key_id, bound_control_head_id: request.core.bound_control_head_id, suite_id: HC2_CRYPTO_SUITE_ID });
    const identity = await derivePossessionProofIdentity(core); const signature = await input.sign(buildEnrollmentSignaturePreimage("possession_response", core.project_id, identity.id));
    return parsePossessionProofRecord({ record_version: 1, record_kind: "possession_proof", authority: "none", proof_id: identity.id, core, algorithm: "ed25519", signature_bytes: signature });
  } finally { plaintext.fill(0); opened.plaintext.fill(0); }
}

export async function verifyPossessionProof(input: Readonly<{
  proof: PossessionProofRecord;
  request: EnrollmentRequestRecord;
  challenge: PossessionChallengeEnvelope;
  expected_response_sha256: Uint8Array;
  current_control_head_id: ControlEventId;
  subtle?: SubtleCrypto;
}>): Promise<boolean> {
  try {
    const proof = parsePossessionProofRecord(input.proof); const request = parseEnrollmentRequestRecord(input.request); const challenge = parsePossessionChallengeEnvelope(input.challenge);
    if (proof.core.challenge_id !== challenge.challenge_id || proof.core.request_id !== request.request_id || proof.core.bound_control_head_id !== parseDigestId("control-event", input.current_control_head_id) ||
        !sameBytes(proof.core.challenge_commitment, challenge.header_core.challenge_commitment) || !sameBytes(proof.core.challenge_response, exactDigest(input.expected_response_sha256, "expected challenge response"))) return false;
    assertChallengeRequestBinding(challenge.header_core, request);
    const identity = await derivePossessionProofIdentity(proof.core); if (identity.id !== proof.proof_id) return false;
    const imported = await importEncodedPublicKey({ subtle: input.subtle ?? requireSubtle(), encoded: request.core.signing_public_key_bytes, expected_algorithm: "ed25519" });
    return (input.subtle ?? requireSubtle()).verify("Ed25519", imported.public_key, asArrayBuffer(proof.signature_bytes), asArrayBuffer(buildEnrollmentSignaturePreimage("possession_response", proof.core.project_id, proof.proof_id)));
  } catch { return false; }
}

export function encodeEpochDeliveryPlaintext(value: EpochDeliveryPlaintext): Uint8Array { return encodeCanonicalCbor(canonicalProtocolValue(parseEpochDeliveryPlaintext(value))); }
export function decodeEpochDeliveryPlaintext(value: Uint8Array): EpochDeliveryPlaintext { if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 2048) throw new Error("Epoch delivery plaintext exceeds its exact bound."); const decoded = decodeCanonicalCbor(Uint8Array.from(value)); const canonical = encodeCanonicalCbor(decoded); if (!sameBytes(canonical, value)) throw new Error("Epoch delivery plaintext is not canonical."); return parseEpochDeliveryPlaintext(protocolValueFromCanonical(decoded)); }
export function encodeEpochDeliveryEnvelope(value: EpochDeliveryEnvelope): Uint8Array { return encodeCanonicalCbor(canonicalProtocolValue(parseEpochDeliveryEnvelope(value))); }
export function decodeEpochDeliveryEnvelope(value: Uint8Array): EpochDeliveryEnvelope { if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 4096) throw new Error("Epoch delivery envelope exceeds its exact bound."); const decoded = decodeCanonicalCbor(Uint8Array.from(value)); const canonical = encodeCanonicalCbor(decoded); if (!sameBytes(canonical, value)) throw new Error("Epoch delivery envelope is not canonical."); const protocol = protocolValueFromCanonical(decoded) as { header_core?: { recipient_ordinal?: unknown; recipient_count?: unknown }; public_header?: { ciphertext_length?: unknown } }; if (protocol.header_core) { protocol.header_core.recipient_ordinal = BigInt(protocol.header_core.recipient_ordinal as number); protocol.header_core.recipient_count = BigInt(protocol.header_core.recipient_count as number); } if (protocol.public_header) protocol.public_header.ciphertext_length = BigInt(protocol.public_header.ciphertext_length as number); return parseEpochDeliveryEnvelope(protocol); }

export async function createEpochDeliveryEnvelope(input: Readonly<{
  header_core: EpochDeliveryHeaderCore;
  recipient_public_key_bytes: EnrollmentRequestRecord["core"]["recipient_public_key_bytes"];
  public_commitment_bytes: Uint8Array;
  epoch_secret: Uint8Array;
  hpke: RecipientEnvelopeProvider;
}>): Promise<EpochDeliveryEnvelope> {
  const headerCore = parseEpochDeliveryHeaderCore(input.header_core); const secret = exactDigest(input.epoch_secret, "epoch secret");
  const plaintext = encodeEpochDeliveryPlaintext({ schema_version: 1, record_kind: "epoch_delivery_plaintext", project_id: headerCore.project_id, accepted_control_event_id: headerCore.accepted_control_event_id, delivery_set_id: headerCore.delivery_set_id, key_epoch_id: headerCore.key_epoch_id, key_epoch_commitment: headerCore.key_epoch_commitment, public_commitment_bytes: exactDigest(input.public_commitment_bytes, "epoch commitment bytes"), epoch_secret: secret, suite_id: headerCore.suite_id });
  try {
    const routingTag = await digestEnrollmentHeader(headerCore); const headerDigest = await sha256(encodeCanonicalCbor(canonicalProtocolValue(headerCore))); const binding = envelopeBinding(routingTag, headerDigest); const info = buildHpkeInfo(binding); let publicHeader: PublicEnvelopeHeader | null = null;
    const sealed = await input.hpke.sealBound({ recipient_public_key: input.recipient_public_key_bytes, info, plaintext, finalize_aad(encapsulatedKeyBytes) { publicHeader = { magic: HC2_ENVELOPE_MAGIC, ...binding, encapsulated_key_bytes: Uint8Array.from(encapsulatedKeyBytes), ciphertext_length: BigInt(plaintext.length + 16) }; return buildBoundHpkeAad(publicHeader); } });
    if (!publicHeader) throw new Error("HPKE epoch header was not finalized.");
    const withoutId = Object.freeze({ record_version: 1 as const, record_kind: "epoch_delivery_envelope" as const, authority: "none" as const, header_core: headerCore, public_header: publicHeader, ciphertext_bytes: Uint8Array.from(sealed.ciphertext_bytes) });
    const identity = await deriveEpochDeliveryIdentity(withoutId); return parseEpochDeliveryEnvelope({ ...withoutId, delivery_id: identity.id });
  } finally { secret.fill(0); plaintext.fill(0); }
}

export async function openEpochDelivery<T>(input: Readonly<{
  envelope: EpochDeliveryEnvelope;
  expected_project_id: ProjectId;
  expected_device_id: DeviceId;
  open: (input: Readonly<{ info: ReturnType<typeof buildHpkeInfo>; public_header: PublicEnvelopeHeader; ciphertext_bytes: HpkeCiphertextBytes }>) => Promise<Readonly<{ status: "opened"; plaintext: Uint8Array }> | Readonly<{ status: "rejected" }>>;
  use: (plaintext: EpochDeliveryPlaintext) => T | Promise<T>;
}>): Promise<T> {
  const envelope = parseEpochDeliveryEnvelope(input.envelope); if (envelope.header_core.project_id !== parseEntityId("project", input.expected_project_id) || envelope.header_core.recipient_device_id !== parseEntityId("device", input.expected_device_id)) throw new Error("Epoch delivery recipient binding is invalid.");
  const identity = await deriveEpochDeliveryIdentity({ record_version: envelope.record_version, record_kind: envelope.record_kind, authority: envelope.authority, header_core: envelope.header_core, public_header: envelope.public_header, ciphertext_bytes: envelope.ciphertext_bytes }); if (identity.id !== envelope.delivery_id) throw new Error("Epoch delivery identity mismatch.");
  if (!sameBytes(await digestEnrollmentHeader(envelope.header_core), envelope.public_header.recipient_routing_tag)) throw new Error("Epoch delivery AAD commitment is invalid.");
  const opened = await input.open({ info: buildHpkeInfo(envelope.public_header), public_header: envelope.public_header, ciphertext_bytes: envelope.ciphertext_bytes as HpkeCiphertextBytes }); if (opened.status !== "opened") throw new Error("Epoch delivery authentication failed.");
  try { const plaintext = decodeEpochDeliveryPlaintext(opened.plaintext); if (plaintext.project_id !== envelope.header_core.project_id || plaintext.accepted_control_event_id !== envelope.header_core.accepted_control_event_id || plaintext.delivery_set_id !== envelope.header_core.delivery_set_id || plaintext.key_epoch_id !== envelope.header_core.key_epoch_id || plaintext.key_epoch_commitment !== envelope.header_core.key_epoch_commitment) throw new Error("Epoch delivery plaintext differs from its authenticated header."); return await input.use(plaintext); } finally { opened.plaintext.fill(0); }
}

export async function verifyCompleteEpochDeliverySet(input: Readonly<{
  transition: MembershipTransitionCore;
  recipient_manifest: RecipientManifestCore;
  delivery_set: DeliverySetCore;
  envelopes: readonly EpochDeliveryEnvelope[];
}>): Promise<Readonly<{ status: "verified" }> | Readonly<{ status: "rejected"; reason: string }>> {
  try {
    const transition = parseMembershipTransitionCore(input.transition); const manifest = parseRecipientManifestCore(input.recipient_manifest); const set = parseDeliverySetCore(input.delivery_set);
    const transitionId = (await deriveMembershipTransitionIdentity(transition)).id;
    if (transition.recipient_manifest_id !== (await deriveRecipientManifestIdentity(manifest)).id ||
        transition.delivery_set_id !== (await deriveDeliverySetIdentity(set)).id ||
        set.recipient_manifest_id !== transition.recipient_manifest_id || set.replacement_epoch_id !== transition.replacement_epoch_id ||
        set.replacement_epoch_commitment !== transition.replacement_epoch_commitment || input.envelopes.length !== manifest.recipients.length) throw new Error("Delivery set does not match its accepted transition and recipient manifest.");
    const envelopes = input.envelopes.map(parseEpochDeliveryEnvelope); const ids = new Set<string>(); const devices = new Set<string>();
    for (let index = 0; index < manifest.recipients.length; index += 1) {
      const recipient = manifest.recipients[index]; const envelope = envelopes.find((entry) => entry.header_core.recipient_device_id === recipient.device_id);
      if (!envelope || ids.has(envelope.delivery_id) || devices.has(recipient.device_id)) throw new Error("A required recipient envelope is missing, duplicated, or substituted.");
      const identity = await deriveEpochDeliveryIdentity({ record_version: envelope.record_version, record_kind: envelope.record_kind, authority: envelope.authority, header_core: envelope.header_core, public_header: envelope.public_header, ciphertext_bytes: envelope.ciphertext_bytes });
      const header = envelope.header_core;
      if (identity.id !== envelope.delivery_id || header.project_id !== transition.project_id || header.transition_id !== transitionId ||
          header.delivery_set_id !== transition.delivery_set_id || header.recipient_manifest_id !== transition.recipient_manifest_id ||
          header.key_epoch_id !== transition.replacement_epoch_id || header.key_epoch_commitment !== transition.replacement_epoch_commitment ||
          header.recipient_membership_id !== recipient.membership_id || header.recipient_person_id !== recipient.person_id ||
          header.recipient_device_id !== recipient.device_id || header.recipient_key_id !== recipient.recipient_key_id ||
          header.recipient_ordinal !== BigInt(index) || header.recipient_count !== BigInt(manifest.recipients.length)) throw new Error("Recipient envelope has an invalid accepted delivery binding.");
      ids.add(envelope.delivery_id); devices.add(recipient.device_id);
    }
    return Object.freeze({ status: "verified" as const });
  } catch (error) { return Object.freeze({ status: "rejected" as const, reason: error instanceof Error ? error.message : "delivery_set_rejected" }); }
}

function assertChallengeRequestBinding(header: PossessionChallengeHeaderCore, request: EnrollmentRequestRecord): void { if (header.project_id !== request.core.project_id || header.invitation_id !== request.core.invitation_id || header.request_id !== request.request_id || header.candidate_person_id !== request.core.candidate_person_id || header.candidate_device_id !== request.core.candidate_device_id || header.signing_key_id !== request.core.signing_key_id || header.recipient_key_id !== request.core.recipient_key_id || header.bound_control_head_id !== request.core.bound_control_head_id || header.suite_id !== request.core.suite_id) throw new Error("Possession challenge does not bind the exact enrollment request."); }
function envelopeBinding(routingTag: Uint8Array, digest: Uint8Array) { return Object.freeze({ envelope_version: 1 as const, suite_id: HC2_CRYPTO_SUITE_ID, envelope_id: parseEnvelopeId(encodeSha256Base32(exactDigest(digest, "envelope derivation digest")).slice(0, 26)), recipient_routing_tag: exactDigest(routingTag, "recipient routing tag"), chunk_ordinal: 0, chunk_count: 1 }); }
async function domainHash(domain: string, value: Uint8Array): Promise<Uint8Array> { return Uint8Array.from(await sha256(encodeCanonicalCbor(canonicalArray([canonicalText(domain), canonicalBytes(Uint8Array.from(value))])))); }
function exactDigest(value: unknown, label: string): Uint8Array { if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(`${label} must contain exactly 32 bytes.`); return Uint8Array.from(value); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function requireSubtle(): SubtleCrypto { if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable."); return globalThis.crypto.subtle; }
function asArrayBuffer(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }

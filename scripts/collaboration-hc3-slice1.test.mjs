import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import {
  deriveEnrollmentRequestIdentity,
  deriveInvitationEvidenceIdentity,
  derivePossessionProofIdentity,
  parseEnrollmentRequestCore,
  parseEnrollmentRequestRecord,
  parseInvitationEvidenceCore,
  parseInvitationHandoffCore,
  parsePossessionProofRecord,
  parsePossessionResponseCore
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { Hc2InMemoryEnrollmentStore } from "../lib/collaboration/hc2/enrollment-store.ts";
import { encodeAlgorithmTaggedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "../lib/collaboration/hc2/versions.ts";
import {
  createEncryptedContainerRecordV2
} from "../lib/collaboration/hc2/transport-v2-contracts.ts";
import {
  createEncryptedContainerRecordV3
} from "../lib/collaboration/hc2/transport-v3-contracts.ts";
import {
  assertHc3CarrierExcludesUtf8Sentinels,
  assertHc3ConnectionAnswerBinding,
  buildHc3ConnectionOfferCommitmentPreimage,
  createHc3ConnectionAnswer,
  createHc3ConnectionOffer,
  createHc3HandoffCarrier,
  decodeHc3Carrier,
  encodeHc3Carrier,
  extractHc2HandoffPayload,
  parseHc3Carrier,
  parseHc3ConnectionCarrier,
  parseHc3HandoffCarrier
} from "../lib/collaboration/hc3/contracts.ts";
import {
  createHc3EncryptedBundleFilename,
  hc3EncryptedBundleFileMetadata,
  inspectHc3EncryptedBundleFile,
  parseHc3EncryptedBundleFilename
} from "../lib/collaboration/hc3/bundle-files.ts";
import { createHc3FragmentLink, parseHc3FragmentLink } from "../lib/collaboration/hc3/link.ts";
import { assessHc3SingleQrEligibility, isHc3SingleQrCharacterLengthEligible } from "../lib/collaboration/hc3/qr.ts";
import { formatHc3ArtifactText, hc3ArtifactChecksumNotice, parseHc3ArtifactText } from "../lib/collaboration/hc3/text.ts";
import {
  HC3_ENCRYPTED_BUNDLE_EXTENSION,
  HC3_ENCRYPTED_BUNDLE_MEDIA_TYPE,
  hc3CarrierLimits
} from "../lib/collaboration/hc3/versions.ts";

let assertions = 0;
const check = (condition, message) => { assertions += 1; assert(condition, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const throws = (operation, matcher, message) => { assertions += 1; assert.throws(operation, matcher, message); };
const rejects = async (operation, matcher, message) => { assertions += 1; await assert.rejects(operation, matcher, message); };

const records = await handoffRecords();
const invitationCarrier = createHc3HandoffCarrier({ artifact_kind: "invitation_handoff", payload: records.handoff });
const enrollmentCarrier = createHc3HandoffCarrier({ artifact_kind: "enrollment_request", payload: records.request });
const proofCarrier = createHc3HandoffCarrier({ artifact_kind: "possession_proof", payload: records.proof });

for (const carrier of [invitationCarrier, enrollmentCarrier, proofCarrier]) {
  const encoded = encodeHc3Carrier(carrier);
  equal(decodeHc3Carrier(encoded), carrier, `${carrier.artifact_kind} exact canonical bytes round trip`);
  equal(parseHc3Carrier(carrier).authority, "none", `${carrier.artifact_kind} remains explicitly authority-free`);
  equal(extractHc2HandoffPayload(carrier).authority, "none", `${carrier.artifact_kind} unwraps only through its existing HC-2 parser`);
  const text = formatHc3ArtifactText(carrier);
  equal(parseHc3ArtifactText(text).carrier, carrier, `${carrier.artifact_kind} canonical text round trips`);
}

throws(() => parseHc3HandoffCarrier({ ...invitationCarrier, unexpected: true }), /unexpected field/i, "unknown carrier fields fail exact parsing");
throws(() => parseHc3HandoffCarrier({ ...invitationCarrier, artifact_version: 2 }), /version/i, "unknown carrier versions fail");
throws(() => parseHc3HandoffCarrier({ ...invitationCarrier, artifact_kind: "enrollment_request" }), /enrollment|request|record/i, "cross-family payload substitution fails");
throws(() => parseHc3HandoffCarrier({ ...invitationCarrier, authority: "member" }), /authority/i, "carriers cannot acquire authority");
throws(() => parseHc3HandoffCarrier({ ...invitationCarrier, payload_bytes: new Uint8Array(16 * 1024 + 1) }), /limit/i, "invitation payload +1 rejects before copying or decoding");

const sessionId = syncId("sync-session", "s");
const offer = createHc3ConnectionOffer({
  session_id: sessionId,
  session_generation: 4n,
  transport_adapter_tag: Uint8Array.of(0x01, 0x03),
  transport_description_bytes: new TextEncoder().encode("opaque-offer-description")
});
const offerCommitment = digest(buildHc3ConnectionOfferCommitmentPreimage(offer));
const answer = createHc3ConnectionAnswer({
  session_id: sessionId,
  session_generation: 4n,
  transport_adapter_tag: Uint8Array.of(0x01, 0x03),
  transport_description_bytes: new TextEncoder().encode("opaque-answer-description"),
  offer_commitment_sha256: offerCommitment
});
assertHc3ConnectionAnswerBinding({ offer, answer, expected_offer_commitment_sha256: offerCommitment });
assertions += 1;
throws(() => assertHc3ConnectionAnswerBinding({ offer, answer: { ...answer, session_id: syncId("sync-session", "t") }, expected_offer_commitment_sha256: offerCommitment }), /does not bind/i, "wrong-session answers fail");
throws(() => assertHc3ConnectionAnswerBinding({ offer, answer, expected_offer_commitment_sha256: new Uint8Array(32) }), /does not bind/i, "substituted offer commitments fail");
throws(() => parseHc3ConnectionCarrier({ ...offer, transport_description_bytes: new Uint8Array(hc3CarrierLimits.maximum_connection_description_bytes + 1) }), /limit/i, "opaque transport descriptions reject +1 before copying");
throws(() => parseHc3ConnectionCarrier({ ...answer, offer_commitment_sha256: null }), /32 bytes|Uint8Array/i, "answers require the exact offer commitment");

const offerText = formatHc3ArtifactText(offer);
const answerText = formatHc3ArtifactText(answer);
equal(parseHc3ArtifactText(offerText).carrier, offer, "connection offer text round trips");
equal(parseHc3ArtifactText(answerText).carrier, answer, "connection answer text round trips");
check(hc3ArtifactChecksumNotice().includes("accidental") && hc3ArtifactChecksumNotice().includes("HC-2"), "checksum notice does not claim authentication");

const invitationText = formatHc3ArtifactText(invitationCarrier);
const corruptChecksum = `${invitationText.slice(0, -1)}${invitationText.endsWith("0") ? "1" : "0"}`;
for (const [invalid, matcher] of [
  [` ${invitationText}`, /whitespace|confusable/i],
  [invitationText.replace("pmhc3", "PMHC3"), /prefix/i],
  [invitationText.replace("pmhc3", "pmһc3"), /confusable/i],
  [`${invitationText}.trailing`, /prefix/i],
  [corruptChecksum, /checksum/i],
  [invitationText.replace(".v1.", ".v2."), /prefix/i],
  [invitationText.replace(".ih.", ".zz."), /kind|checksum/i],
  [`${invitationText}=`, /padding|confusable/i]
]) throws(() => parseHc3ArtifactText(invalid), matcher, "noncanonical artifact text fails closed");
const malformedProtected = "pmhc3.v1.ih.A";
throws(() => parseHc3ArtifactText(`${malformedProtected}.${crc32c(malformedProtected)}`), /Base64url/i, "malformed Base64url rejects after a valid accidental checksum");
throws(() => parseHc3ArtifactText("a".repeat(hc3CarrierLimits.maximum_canonical_text_characters + 1)), /limit/i, "oversized text rejects before Base64 allocation");

const baseUrl = "https://patchmark.invalid/collaboration/open";
const link = createHc3FragmentLink({ base_url: baseUrl, artifact_text: invitationText });
equal(parseHc3FragmentLink({ link, expected_base_url: baseUrl }).carrier, invitationCarrier, "fragment-only handoff link round trips without navigation");
check(link.includes("#pmhc3.") && !link.includes("?"), "self-contained payload appears only in the URL fragment");
throws(() => parseHc3FragmentLink({ link: `${baseUrl}?handoff=${invitationText}#${invitationText}`, expected_base_url: baseUrl }), /path or query/i, "query payloads reject");
throws(() => parseHc3FragmentLink({ link: `${baseUrl}/${invitationText}#${invitationText}`, expected_base_url: baseUrl }), /path or query/i, "path payloads reject");
throws(() => parseHc3FragmentLink({ link: `${link}#again`, expected_base_url: baseUrl }), /exactly one/i, "multiple fragments reject");
throws(() => parseHc3FragmentLink({ link: link.replace("pmhc3", "%70mhc3"), expected_base_url: baseUrl }), /escaped/i, "escaped fragment alternatives reject");

const touched = [];
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = () => { touched.push("fetch"); throw new Error("unexpected fetch"); };
globalThis.WebSocket = class { constructor() { touched.push("WebSocket"); throw new Error("unexpected WebSocket"); } };
try {
  parseHc3FragmentLink({ link, expected_base_url: baseUrl });
  parseHc3ArtifactText(invitationText);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
}
equal(touched, [], "link and text parsing perform no navigation or network activity");

const qr = assessHc3SingleQrEligibility(invitationText);
check(qr.eligible && qr.authority === "none", "measured invitation text is eligible for one QR without gaining authority");
check(isHc3SingleQrCharacterLengthEligible(2_953), "exact QR character boundary is eligible");
check(!isHc3SingleQrCharacterLengthEligible(2_954), "QR +1 rejects without truncation, compression, or fragmentation");

const fileFactory = nodeSha256Factory();
const v2Bytes = await encryptedBundleBytes(2);
const v3Bytes = await encryptedBundleBytes(3);
const v2Evidence = await inspectHc3EncryptedBundleFile({ exact_bytes: v2Bytes, sha256_factory: fileFactory });
const v3Evidence = await inspectHc3EncryptedBundleFile({ exact_bytes: v3Bytes, sha256_factory: fileFactory });
equal(v2Evidence.bundle_version, 2, "V2 is detected from exact versioned container structure rather than filename");
equal(v3Evidence.bundle_version, 3, "V3 is detected from exact versioned container structure rather than filename");
equal((await inspectHc3EncryptedBundleFile({ exact_bytes: v3Bytes, sha256_factory: fileFactory })).sha256, v3Evidence.sha256, "duplicate bundle inspection is harmless and deterministic");
const filename = createHc3EncryptedBundleFilename(v3Evidence.sha256);
equal(parseHc3EncryptedBundleFilename(filename).sha256, v3Evidence.sha256, "opaque deterministic filename round trips as operational metadata");
check(filename.endsWith(HC3_ENCRYPTED_BUNDLE_EXTENSION) && !filename.includes("project") && !filename.includes("person"), "filename exposes no project or person name");
equal(hc3EncryptedBundleFileMetadata(), { authority: "none", extension: HC3_ENCRYPTED_BUNDLE_EXTENSION, media_type: HC3_ENCRYPTED_BUNDLE_MEDIA_TYPE, detection: "versioned_structure_reauthenticated_by_hc2_import" }, "extension and media type are authority-free hints");
await rejects(() => inspectHc3EncryptedBundleFile({ exact_bytes: v3Bytes.slice(0, -1), sha256_factory: fileFactory }), /malformed|truncated/i, "truncated encrypted bundles fail");
await rejects(() => inspectHc3EncryptedBundleFile({ exact_bytes: concat(v3Bytes, Uint8Array.of(0)), sha256_factory: fileFactory }), /appended|malformed/i, "appended encrypted bundles fail");
const mixed = encodeCanonicalCbor(canonicalProtocolValue([await encryptedContainer(2), await encryptedContainer(3)]));
await rejects(() => inspectHc3EncryptedBundleFile({ exact_bytes: mixed, sha256_factory: fileFactory }), /mixed-version|malformed/i, "mixed V2/V3 files fail");

assertHc3CarrierExcludesUtf8Sentinels(invitationCarrier, ["Secret Project", "/Users/private/project", "epoch_secret", "root_seed", "editor_state"]);
assertions += 1;
throws(() => assertHc3CarrierExcludesUtf8Sentinels(createHc3ConnectionOffer({ ...offer, transport_description_bytes: new TextEncoder().encode("Secret Project") }), ["Secret Project"]), /privacy sentinel/i, "privacy sentinel scan detects forbidden carrier content");

const store = new Hc2InMemoryEnrollmentStore();
await store.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: records.evidence.invitation_id, evidence: records.evidence,
  status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
const transition = hc2Digest("membership-transition", "m");
const acceptedHead = hc1Digest("control-event", "v");
const firstConsumption = await store.consumeInvitation(records.evidence.project_id, records.evidence.invitation_id, "accepted", acceptedHead, transition);
const exactRetry = await store.consumeInvitation(records.evidence.project_id, records.evidence.invitation_id, "accepted", acceptedHead, transition);
equal(firstConsumption, exactRetry, "reopening and resubmitting the same link cannot consume an invitation twice");
await rejects(() => store.consumeInvitation(records.evidence.project_id, records.evidence.invitation_id, "accepted", hc1Digest("control-event", "w"), hc2Digest("membership-transition", "n")), /CAS|terminal/i, "a second distinct invitation consumption fails existing HC-2 CAS");

process.stdout.write(`${JSON.stringify({
  assertions,
  artifact_sizes: {
    invitation_cbor_bytes: encodeHc3Carrier(invitationCarrier).length,
    invitation_text_characters: invitationText.length,
    enrollment_text_characters: formatHc3ArtifactText(enrollmentCarrier).length,
    possession_proof_text_characters: formatHc3ArtifactText(proofCarrier).length,
    connection_offer_text_characters: offerText.length,
    connection_answer_text_characters: answerText.length,
    v2_file_bytes: v2Bytes.length,
    v3_file_bytes: v3Bytes.length
  },
  visible_metadata: ["artifact version", "artifact kind", "opaque HC-2 identifiers", "role", "suite", "opaque V3 session", "adapter tag", "byte lengths"],
  network_calls: touched.length,
  status: "ok"
}, null, 2)}\n`);

async function handoffRecords() {
  const ids = {
    project: entity("project", "a"), invitation: entity("invitation", "b"), ownerMembership: entity("membership", "c"),
    ownerPerson: entity("person", "d"), ownerDevice: entity("device", "e"), scope: entity("access-scope", "f"),
    candidatePerson: entity("person", "g"), candidateMembership: entity("membership", "h"), candidateDevice: entity("device", "j"),
    signingKey: entity("public-key", "k"), recipientKey: entity("public-key", "m"), control: hc1Digest("control-event", "n")
  };
  const evidence = parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none", project_id: ids.project,
    invitation_id: ids.invitation, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice,
    intended_role: "editor", access_scope: "project_wide", access_scope_id: ids.scope, creation_control_head_id: ids.control,
    creation_control_sequence: 2n, valid_through_control_sequence: 12n, accepted_invitation_action_id: hc1Digest("control-action", "p"),
    accepted_invitation_control_event_id: ids.control, status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID });
  const evidenceId = (await deriveInvitationEvidenceIdentity(evidence)).id;
  const handoff = parseInvitationHandoffCore({ schema_version: 1, record_kind: "invitation_handoff_core", authority: "none", project_id: ids.project,
    invitation_id: ids.invitation, invitation_evidence_id: evidenceId, accepted_invitation_control_event_id: ids.control,
    intended_role: "editor", access_scope: "project_wide", suite_id: HC2_CRYPTO_SUITE_ID });
  const signingPublic = encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: ids.signingKey, raw_public_key: new Uint8Array(32).fill(0x31) });
  const recipientPublic = encodeAlgorithmTaggedPublicKey({ algorithm: "x25519", key_id: ids.recipientKey, raw_public_key: new Uint8Array(32).fill(0x32) });
  const requestCore = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "new_person",
    project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: evidenceId, accepted_invitation_control_event_id: ids.control,
    candidate_person_id: ids.candidatePerson, existing_membership_id: null, proposed_membership_id: ids.candidateMembership, candidate_device_id: ids.candidateDevice,
    signing_key_id: ids.signingKey, signing_public_key_bytes: signingPublic, recipient_key_id: ids.recipientKey, recipient_public_key_bytes: recipientPublic,
    intended_role: "editor", access_scope: "project_wide", access_scope_id: ids.scope, bound_control_head_id: ids.control,
    request_nonce: new Uint8Array(32).fill(0x33), suite_id: HC2_CRYPTO_SUITE_ID });
  const requestId = (await deriveEnrollmentRequestIdentity(requestCore)).id;
  const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: requestId,
    core: requestCore, algorithm: "ed25519", signature_bytes: new Uint8Array(64).fill(0x34) });
  const proofCore = parsePossessionResponseCore({ schema_version: 1, record_kind: "possession_response_core", authority: "none", project_id: ids.project,
    invitation_id: ids.invitation, request_id: requestId, challenge_id: hc2Digest("possession-challenge", "q"),
    challenge_commitment: new Uint8Array(32).fill(0x35), challenge_response: new Uint8Array(32).fill(0x36), candidate_person_id: ids.candidatePerson,
    candidate_device_id: ids.candidateDevice, signing_key_id: ids.signingKey, recipient_key_id: ids.recipientKey,
    bound_control_head_id: ids.control, suite_id: HC2_CRYPTO_SUITE_ID });
  const proofId = (await derivePossessionProofIdentity(proofCore)).id;
  const proof = parsePossessionProofRecord({ record_version: 1, record_kind: "possession_proof", authority: "none", proof_id: proofId,
    core: proofCore, algorithm: "ed25519", signature_bytes: new Uint8Array(64).fill(0x37) });
  return Object.freeze({ evidence, handoff, request, proof });
}

async function encryptedBundleBytes(version) {
  return encodeCanonicalCbor(canonicalProtocolValue([await encryptedContainer(version)]));
}

async function encryptedContainer(version) {
  const ciphertext = new Uint8Array(version === 2 ? 48 : 49).fill(version === 2 ? 0xa2 : 0xa3);
  const commonHeader = {
    magic: HC2_ENVELOPE_MAGIC,
    envelope_version: version,
    suite_id: HC2_CRYPTO_SUITE_ID,
    encapsulated_key_bytes: new Uint8Array(32).fill(version),
    envelope_id: (version === 2 ? "a" : "b").repeat(26),
    recipient_routing_tag: new Uint8Array(32).fill(version + 1),
    chunk_ordinal: 0,
    chunk_count: 1,
    ciphertext_length: BigInt(ciphertext.length)
  };
  return version === 2
    ? createEncryptedContainerRecordV2({ schema_version: 2, record_kind: "encrypted_container_core_v2", public_header: commonHeader, ciphertext_bytes: ciphertext })
    : createEncryptedContainerRecordV3({ schema_version: 3, record_kind: "encrypted_container_core_v3", public_header: commonHeader, ciphertext_bytes: ciphertext });
}

function nodeSha256Factory() {
  return Object.freeze({
    createSha256() {
      const hash = createHash("sha256");
      return { update(bytes) { hash.update(bytes); }, digest() { return new Uint8Array(hash.digest()); } };
    }
  });
}

function digest(bytes) { return new Uint8Array(createHash("sha256").update(bytes).digest()); }
function entity(kind, char) { return `pm:${kind}:v1:${char.repeat(25)}a`; }
function hc1Digest(kind, char) { return `pm:${kind}:v1:${char.repeat(51)}a`; }
function hc2Digest(kind, char) { return `pm:${kind}:v1:${char.repeat(51)}a`; }
function syncId(kind, char) { return `pm:${kind}:v3:${char.repeat(51)}a`; }
function concat(left, right) { const result = new Uint8Array(left.length + right.length); result.set(left); result.set(right, left.length); return result; }
function crc32c(value) { let crc = 0xffffffff; for (let index = 0; index < value.length; index += 1) { crc ^= value.charCodeAt(index); for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); } return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0"); }

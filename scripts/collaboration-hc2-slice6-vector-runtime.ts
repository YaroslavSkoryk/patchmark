/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- frozen test material intentionally crosses branded contracts.
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { deriveMarkdownBlobIdentity } from "../lib/collaboration/preimages.ts";
import { sha256 } from "../lib/collaboration/sha256.ts";
import { createChunkPayloadCore } from "../lib/collaboration/hc2/envelope.ts";
import { encodeAlgorithmTaggedPublicKey, importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { SingleShotHpkeV2Provider } from "../lib/collaboration/hc2/providers/hpke-v2-provider.ts";
import {
  buildTransportBoundAadV2,
  buildTransportHpkeInfoV2,
  encodeEncryptedContainerRecordV2,
  parseEncryptedContainerRecordV2
} from "../lib/collaboration/hc2/transport-v2-contracts.ts";
import { deriveTransportStreamIdV2, prepareEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-v2-crypto.ts";
import { importEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-import.ts";
import { InMemoryTransportStreamJournalV2 } from "../lib/collaboration/hc2/transport-stream-store.ts";
import { InMemoryTransportAttachmentByteBackend, PortableTransportAttachmentStoreV2 } from "../lib/collaboration/hc2/transport-attachment-store.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_LIMIT_PROFILE_ID } from "../lib/collaboration/hc2/versions.ts";
import { HC2_TRANSPORT_PROFILE_ID, HC2_TRANSPORT_SCHEMA_VERSION } from "../lib/collaboration/hc2/transport-v2-versions.ts";

export async function createSlice6VectorActual(input) {
  const suite = hpkeSuite();
  const recipientPair = await suite.kem.deriveKeyPair(hex(input.recipient_x25519_ikm_hex));
  const recipientRaw = new Uint8Array(await suite.kem.serializePublicKey(recipientPair.publicKey));
  const recipientPublic = encodeAlgorithmTaggedPublicKey({ algorithm: "x25519", key_id: ids.recipientKey, raw_public_key: recipientRaw });
  const signerPrivate = await crypto.subtle.importKey("pkcs8", concatHex("302e020100300506032b657004220420", input.sender_ed25519_seed_hex), "Ed25519", false, ["sign"]);
  const signerPublicRaw = hex(input.sender_ed25519_public_hex);
  const signerPublic = encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: ids.senderSigning, raw_public_key: signerPublicRaw });
  const signaturePreimages = [];
  const signatures = {
    async sign(preimage) { signaturePreimages.push(Uint8Array.from(preimage)); return new Uint8Array(await crypto.subtle.sign("Ed25519", signerPrivate, preimage)); },
    async verify({ preimage, signature_bytes }) { const imported = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: signerPublic, expected_algorithm: "ed25519" }); return crypto.subtle.verify("Ed25519", imported.public_key, signature_bytes, preimage); }
  };
  const markdown = new TextEncoder().encode(input.markdown_text);
  const blob = await deriveMarkdownBlobIdentity(ids.project, markdown);
  const chunk = await createChunkPayloadCore({ project_id: ids.project, scope_id: ids.scope, sender_person_id: ids.senderPerson,
    sender_device_id: ids.senderDevice, recipient_device_id: ids.recipientDevice, recipient_key_id: ids.recipientKey,
    key_epoch_id: ids.epoch, accepted_control_head_id: ids.control, bundle_kind: "collaboration_exchange",
    objects: [{ object_kind: "markdown-blob", object_id: blob.id, exact_bytes: markdown, dependency_ids: [], dependency_depth: 0 }] });
  const streamId = await deriveTransportStreamIdV2({ project_id: ids.project, purpose: "replication", sender_person_id: ids.senderPerson,
    sender_membership_id: ids.senderMembership, sender_device_id: ids.senderDevice, recipient_person_id: ids.recipientPerson,
    recipient_membership_id: ids.recipientMembership, recipient_device_id: ids.recipientDevice, recipient_key_id: ids.recipientKey,
    stream_generation: 0n });
  const common = Object.freeze({ transport_profile_id: HC2_TRANSPORT_PROFILE_ID, project_id: ids.project, purpose: "replication",
    sender_person_id: ids.senderPerson, sender_membership_id: ids.senderMembership, sender_device_id: ids.senderDevice,
    sender_signing_key_id: ids.senderSigning, recipient_authority: "accepted_member", recipient_person_id: ids.recipientPerson,
    recipient_membership_id: ids.recipientMembership, recipient_device_id: ids.recipientDevice, recipient_key_id: ids.recipientKey,
    accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment, stream_id: streamId,
    stream_generation: 0n, bundle_sequence: 0n, previous_bundle_manifest_id: null, payload_count: 2,
    limit_profile_id: HC2_LIMIT_PROFILE_ID, crypto_suite_id: HC2_CRYPTO_SUITE_ID });
  const hpke = new DeterministicTransportHpke(input.ephemeral_x25519_ikm_hexes);
  const bundle = await prepareEncryptedTransportBundleV2({ common_binding: common,
    non_manifest_payloads: [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk }],
    recipient_public_key: recipientPublic, authority: acceptedExportAuthority,
    random: fixedRandom(hex(input.envelope_id_random_hex)), signatures, hpke });
  lastPortableTransfer = toPortable({ containers: bundle.containers, sender_public_key: signerPublic });
  const recordBytes = bundle.containers.map(encodeEncryptedContainerRecordV2);
  const bundleBytes = concat([Uint8Array.of(0x80 | recordBytes.length), ...recordBytes]);
  return clean({
    profile_id: HC2_TRANSPORT_PROFILE_ID,
    stream_id: streamId,
    markdown_blob_id: blob.id,
    manifest_id: bundle.manifest_id,
    payload_kinds: bundle.payloads.map((entry) => entry.payload_kind),
    payload_canonical_lengths: bundle.payloads.map((entry) => encodeCanonicalCbor(canonicalProtocolValue(entry)).length),
    signature_preimage_lengths: signaturePreimages.map((entry) => entry.length),
    signature_preimage_sha256: await Promise.all(signaturePreimages.map(hashHex)),
    hpke_info_hex: hpke.evidence.map((entry) => toHex(entry.info)),
    aad_hex: hpke.evidence.map((entry) => toHex(entry.aad)),
    ciphertext_sha256: await Promise.all(hpke.evidence.map((entry) => hashHex(entry.ciphertext))),
    ciphertext_lengths: hpke.evidence.map((entry) => entry.ciphertext.length),
    encapsulated_key_hex: hpke.evidence.map((entry) => toHex(entry.enc)),
    container_ids: bundle.containers.map((entry) => entry.container_id),
    container_canonical_lengths: recordBytes.map((entry) => entry.length),
    container_sha256: await Promise.all(recordBytes.map(hashHex)),
    bundle_canonical_length: bundleBytes.length,
    bundle_sha256: await hashHex(bundleBytes),
    public_header_keys: Object.keys(bundle.containers[0].core.public_header).sort(),
    derivation_order: ["non_manifest_payload_commitments", "manifest_core", "manifest_commitment", "transport_binding", "sender_signature", "hpke_setup", "opaque_header", "aad", "seal_once", "container_identity", "canonical_bundle"]
  });
}

let lastPortableTransfer = null;

const acceptedExportAuthority = Object.freeze({
  async verify() { return Object.freeze({ status: "accepted", epoch_key_available: true }); }
});

export async function createSlice6PortableTransfer(input) {
  await createSlice6VectorActual(input);
  return structuredClone(lastPortableTransfer);
}

export async function importSlice6PortableTransfer(input, portable) {
  const suite = hpkeSuite();
  const derived = await suite.kem.deriveKeyPair(hex(input.recipient_x25519_ikm_hex));
  const privateJwk = await crypto.subtle.exportKey("jwk", derived.privateKey);
  const pair = { publicKey: derived.publicKey, privateKey: await crypto.subtle.importKey("jwk", privateJwk, { name: "X25519" }, false, ["deriveBits"]) };
  const registry = new Hc2NativeKeyRegistry(crypto.subtle);
  const recipient = await registry.adoptRecipientKeyPair(ids.recipientKey, pair);
  const restored = fromPortable(portable);
  const containers = [];
  for (const value of restored.containers) containers.push(await parseEncryptedContainerRecordV2(value));
  const signatures = {
    async sign() { throw new Error("Recipient verifier cannot sign as the sender."); },
    async verify({ preimage, signature_bytes }) {
      const imported = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: restored.sender_public_key, expected_algorithm: "ed25519" });
      return crypto.subtle.verify("Ed25519", imported.public_key, signature_bytes, preimage);
    }
  };
  const bytes = new Map();
  const result = await importEncryptedTransportBundleV2({
    containers,
    recipient_key_pair: recipient,
    signatures,
    hpke: new SingleShotHpkeV2Provider({ keys: registry }),
    authority: { async verify() { return { status: "accepted", epoch_key_available: true }; } },
    streams: new InMemoryTransportStreamJournalV2(),
    hc1: {
      async stageAndCommitObject(value) { bytes.set(value.object_id, Uint8Array.from(value.exact_bytes)); },
      async hasCommittedObject(id) { return bytes.has(id); }
    },
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() })
  });
  return clean({ status: result.status, reason: result.status === "rejected" ? result.reason : null,
    imported_ids: [...bytes.keys()].sort(), imported_sha256: await Promise.all([...bytes.values()].map(hashHex)),
    private_key_extractable: pair.privateKey.extractable });
}

class DeterministicTransportHpke {
  constructor(ikms) { this.ikms = ikms.map(hex); this.evidence = []; }
  async sealBound(input) {
    const suite = hpkeSuite();
    const decoded = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: input.recipient_public_key, expected_algorithm: "x25519" });
    const ephemeral = await suite.kem.deriveKeyPair(this.ikms[this.evidence.length]);
    const info = buildTransportHpkeInfoV2(input.info_binding);
    const sender = await suite.createSenderContext({ recipientPublicKey: decoded.public_key, info, ekm: ephemeral });
    const enc = new Uint8Array(sender.enc);
    const header = input.finalize_header(enc, BigInt(input.plaintext.length + 16));
    const aad = buildTransportBoundAadV2(header);
    const ciphertext = new Uint8Array(await sender.seal(input.plaintext, aad));
    this.evidence.push({ info: Uint8Array.from(info), aad: Uint8Array.from(aad), ciphertext: Uint8Array.from(ciphertext), enc: Uint8Array.from(enc) });
    return { public_header: header, ciphertext_bytes: ciphertext };
  }
  async openBound() { throw new Error("Vector generator is sender-only."); }
}

function hpkeSuite() { return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }); }
function fixedRandom(value) { let used = false; return { async randomBytes(length) { if (used || value.length !== length) throw new Error("Fixed envelope ID random was reused or mis-sized."); used = true; return Uint8Array.from(value); } }; }
async function hashHex(value) { return toHex(await sha256(value)); }
function hex(value) { return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []); }
function concatHex(prefix, suffix) { return concat([hex(prefix), hex(suffix)]); }
function concat(chunks) { const bytes = new Uint8Array(chunks.reduce((sum, entry) => sum + entry.length, 0)); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes; }
function toHex(value) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }
function toPortable(value) { if (value instanceof Uint8Array) return { __bytes_hex: toHex(value) }; if (Array.isArray(value)) return value.map(toPortable); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPortable(child)])); return typeof value === "bigint" ? { __bigint: value.toString() } : value; }
function fromPortable(value) { if (Array.isArray(value)) return value.map(fromPortable); if (value && typeof value === "object") { if (typeof value.__bytes_hex === "string") return hex(value.__bytes_hex); if (typeof value.__bigint === "string") return BigInt(value.__bigint); return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fromPortable(child)])); } return value; }
function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }

const ids = Object.freeze({ project: entity("project", "a"), scope: entity("access-scope", "b"), senderPerson: entity("person", "c"),
  senderMembership: entity("membership", "d"), senderDevice: entity("device", "e"), senderSigning: entity("public-key", "f"),
  recipientPerson: entity("person", "g"), recipientMembership: entity("membership", "h"), recipientDevice: entity("device", "j"),
  recipientKey: entity("public-key", "k"), epoch: entity("key-epoch", "m"), control: digest("control-event", "n"),
  epochCommitment: digest("key-epoch-commitment", "p") });

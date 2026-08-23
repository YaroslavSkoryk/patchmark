import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import sodium from "libsodium-wrappers-sumo";

import { buildBoundHpkeAad, buildEnvelopeAad, buildHpkeInfo } from "../lib/collaboration/hc2/envelope.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "../lib/collaboration/hc2/versions.ts";
import { NativeEd25519SignatureProvider } from "../lib/collaboration/hc2/providers/ed25519-provider.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import {
  decodeAlgorithmTaggedPublicKey,
  encodeAlgorithmTaggedPublicKey,
  importEncodedPublicKey,
  NativePublicKeyCodec
} from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import {
  buildRecoveryAad,
  decodeRecoveryProtectedRecord,
  HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
  HC2_RECOVERY_ARGON2_OPSLIMIT,
  HC2_RECOVERY_DERIVED_KEY_BYTES,
  HC2_RECOVERY_PARAMETER_VERSION
} from "../lib/collaboration/hc2/providers/recovery-format.ts";
import { WorkerRecoveryProtector } from "../lib/collaboration/hc2/providers/recovery-provider.ts";
import { performRecoveryWorkerOperation } from "../lib/collaboration/hc2/providers/recovery-worker.ts";
import {
  HC2_MAXIMUM_RANDOM_REQUEST_BYTES,
  WebCryptoRandomSource
} from "../lib/collaboration/hc2/providers/secure-random.ts";
import { ExactHc2SuiteNegotiator } from "../lib/collaboration/hc2/providers/suite-negotiator.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/collaboration-hc2-slice3-v1.json", import.meta.url), "utf8"));
const hc1Fixture = JSON.parse(await readFile(new URL("./fixtures/collaboration-canonical-v1.json", import.meta.url), "utf8"));
let assertions = 0;
const check = (condition, message) => { assertions += 1; assert(condition, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const rejects = async (operation, expected) => { assertions += 1; await assert.rejects(operation, expected); };

async function testRandom() {
  const calls = [];
  const fakeCrypto = {
    getRandomValues(view) {
      calls.push(view.length);
      view.fill(calls.length & 0xff);
      return view;
    }
  };
  const source = new WebCryptoRandomSource(fakeCrypto);
  equal((await source.randomBytes(0)).length, 0, "zero-length randomness is permitted");
  const chunked = await source.randomBytes(65_537);
  equal(calls.slice(-2), [65_536, 1], "large random requests must respect getRandomValues limits");
  equal(chunked.length, 65_537, "chunked output has exact length");
  const maximum = await source.randomBytes(HC2_MAXIMUM_RANDOM_REQUEST_BYTES);
  equal(maximum.length, HC2_MAXIMUM_RANDOM_REQUEST_BYTES, "maximum random request succeeds");
  maximum[0] = 255;
  const independent = await source.randomBytes(1);
  check(independent.buffer !== maximum.buffer && independent[0] !== maximum[0], "returned random buffers never alias");
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, HC2_MAXIMUM_RANDOM_REQUEST_BYTES + 1]) {
    await rejects(() => source.randomBytes(invalid), (error) => error?.code === "parameter_mismatch");
  }
  await rejects(() => new WebCryptoRandomSource(null).randomBytes(1), (error) => error?.code === "provider_unavailable");
  await rejects(() => new WebCryptoRandomSource({ getRandomValues() { throw new Error("opaque failure"); } }).randomBytes(1),
    (error) => error?.code === "provider_unavailable" && !error.message.includes("opaque"));
}

async function testStandardsVectors() {
  const ed = fixture.ed25519;
  const edPrivate = await crypto.subtle.importKey("pkcs8", concatHex("302e020100300506032b657004220420", ed.secret_seed_hex), "Ed25519", false, ["sign"]);
  const edPublic = await crypto.subtle.importKey("raw", hex(ed.public_key_hex), "Ed25519", true, ["verify"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", edPrivate, hex(ed.message_hex)));
  equal(toHex(signature), ed.signature_hex, "WebCrypto matches RFC 8032 TEST 1 exactly");
  check(await crypto.subtle.verify("Ed25519", edPublic, signature, hex(ed.message_hex)), "RFC 8032 signature verifies");
  const flippedSignature = Uint8Array.from(signature); flippedSignature[0] ^= 1;
  check(!(await crypto.subtle.verify("Ed25519", edPublic, flippedSignature, hex(ed.message_hex))), "bit-flipped RFC signature fails");

  const x = fixture.x25519;
  const alicePrivate = await crypto.subtle.importKey("pkcs8", concatHex("302e020100300506032b656e04220420", x.alice_private_hex), "X25519", false, ["deriveBits"]);
  const bobPublic = await crypto.subtle.importKey("raw", hex(x.bob_public_hex), "X25519", true, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: bobPublic }, alicePrivate, 256));
  equal(toHex(shared), x.shared_secret_hex, "WebCrypto matches RFC 7748 shared secret");
  await rejects(async () => {
    const lowOrder = await crypto.subtle.importKey("raw", new Uint8Array(32), "X25519", true, []);
    await crypto.subtle.deriveBits({ name: "X25519", public: lowOrder }, alicePrivate, 256);
  }, /derive|operation|valid/i);

  const hpke = fixture.hpke;
  const suite = hpkeSuite();
  const recipient = await suite.kem.deriveKeyPair(hex(hpke.recipient_ikm_hex));
  const ephemeral = await suite.kem.deriveKeyPair(hex(hpke.ephemeral_ikm_hex));
  equal(toHex(new Uint8Array(await suite.kem.serializePublicKey(recipient.publicKey))), hpke.recipient_public_hex, "HPKE recipient derivation matches official vector");
  const sender = await suite.createSenderContext({ recipientPublicKey: recipient.publicKey, info: hex(hpke.info_hex), ekm: ephemeral });
  equal(toHex(new Uint8Array(sender.enc)), hpke.encapsulated_key_hex, "HPKE encapsulated key matches official vector");
  const ciphertext = new Uint8Array(await sender.seal(hex(hpke.plaintext_hex), hex(hpke.aad_hex)));
  equal(toHex(ciphertext), hpke.ciphertext_hex, "HPKE ciphertext matches official vector");
  const receiver = await suite.createRecipientContext({ recipientKey: recipient, enc: hex(hpke.encapsulated_key_hex), info: hex(hpke.info_hex) });
  equal(toHex(new Uint8Array(await receiver.open(ciphertext, hex(hpke.aad_hex)))), hpke.plaintext_hex, "official HPKE ciphertext opens");

  await sodium.ready;
  const xc = fixture.xchacha20_poly1305;
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(hex(xc.plaintext_hex), hex(xc.aad_hex), null, hex(xc.nonce_hex), hex(xc.key_hex));
  equal(toHex(sealed), xc.ciphertext_hex + xc.tag_hex, "libsodium matches the published XChaCha20-Poly1305 vector");
  equal(toHex(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, hex(xc.aad_hex), hex(xc.nonce_hex), hex(xc.key_hex))), xc.plaintext_hex, "published XChaCha vector decrypts");

  const recovery = fixture.patchmark_recovery;
  const recoveryKey = sodium.crypto_pwhash(recovery.derived_key_bytes, hex(recovery.password_hex), hex(recovery.salt_hex), recovery.opslimit, recovery.memlimit_bytes, sodium.crypto_pwhash_ALG_ARGON2ID13);
  equal(toHex(recoveryKey), recovery.derived_key_hex, "production Argon2id parameters match the frozen independent result");
  const recoveryCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(hex(recovery.plaintext_hex), hex(recovery.aad_hex), null, hex(recovery.nonce_hex), recoveryKey);
  equal(toHex(recoveryCiphertext), recovery.ciphertext_and_tag_hex, "production recovery vector matches exactly");
  sodium.memzero(recoveryKey);
}

async function testNativeKeysAndSignatures() {
  const registry = new Hc2NativeKeyRegistry();
  const signingId = entity("public-key", "a");
  const recipientId = entity("public-key", "b");
  const signing = await registry.generateDeviceSigningKey(signingId);
  const recipient = await registry.generateRecipientKeyPair(recipientId);
  const signingPair = registry.resolveSigningKey(signing.handle);
  const recipientPair = registry.resolveRecipientKeyPair(recipient);
  equal(signingPair.extractable, false, "Ed25519 private key is non-extractable");
  equal(recipientPair.privateKey.extractable, false, "X25519 private key is non-extractable");
  equal(recipientPair.publicKey.extractable, true, "X25519 public key remains exportable");
  await rejects(() => crypto.subtle.exportKey("pkcs8", signingPair), /extractable|export|key/i);
  await rejects(() => crypto.subtle.exportKey("pkcs8", recipientPair.privateKey), /extractable|export|key/i);

  const signingDecoded = decodeAlgorithmTaggedPublicKey(signing.public_key, "ed25519");
  const recipientDecoded = decodeAlgorithmTaggedPublicKey(recipient.public_key, "x25519");
  equal(signingDecoded.key_id, signingId, "Ed25519 codec binds key id");
  equal(recipientDecoded.key_id, recipientId, "X25519 codec binds key id");
  equal(signingDecoded.raw_public_key.length, 32, "Ed25519 codec enforces raw length");
  equal(recipientDecoded.raw_public_key.length, 32, "X25519 codec enforces raw length");
  const copiedEncoding = encodeAlgorithmTaggedPublicKey(signingDecoded);
  equal(toHex(copiedEncoding), toHex(signing.public_key), "public-key codec is canonical");
  const malformed = Uint8Array.from(copiedEncoding); malformed.push?.(0);
  await rejects(async () => decodeAlgorithmTaggedPublicKey(Uint8Array.from([...copiedEncoding, 0])), (error) => error?.code === "invalid_key");
  await rejects(async () => decodeAlgorithmTaggedPublicKey(signing.public_key, "x25519"), (error) => error?.code === "invalid_key");
  await rejects(async () => encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: signingId, raw_public_key: new Uint8Array(31) }), (error) => error?.code === "invalid_key");
  await importEncodedPublicKey({ subtle: crypto.subtle, encoded: signing.public_key, expected_algorithm: "ed25519" });
  const frozenCodec = new NativePublicKeyCodec(crypto.subtle);
  await rejects(async () => frozenCodec.decode(signing.public_key), (error) => error?.code === "invalid_key");
  const prepared = await frozenCodec.prepareEncodedPublicKey(signing.public_key);
  equal(frozenCodec.decode(signing.public_key).public_key, prepared.public_key, "frozen synchronous codec returns only an explicitly prepared key");
  equal(toHex(frozenCodec.encode({ algorithm: "ed25519", key_id: signingId, public_key: prepared.public_key })), toHex(signing.public_key), "frozen synchronous codec encodes a prepared key exactly");
  await rejects(async () => frozenCodec.encode({ algorithm: "x25519", key_id: signingId, public_key: prepared.public_key }), (error) => error?.code === "invalid_key");

  const provider = new NativeEd25519SignatureProvider(registry);
  const signer = Object.freeze({
    resolution: "accepted_control_state",
    project_id: entity("project", "c"),
    device_id: entity("device", "d"),
    key_id: signingId,
    control_head_id: digest("control-event", "e"),
    algorithm: "ed25519",
    public_key_bytes: signing.public_key
  });
  for (const vector of hc1Fixture.signatures) {
    const preimage = hex(vector.canonical_preimage_hex);
    const signed = await provider.sign({ key: signing.handle, preimage });
    equal(signed.signature_bytes.length, 64, `${vector.subject_kind} signature has exact length`);
    const verified = await provider.verify({ signer, preimage, signature_bytes: signed.signature_bytes });
    equal(verified.status, "valid_signature", `${vector.subject_kind} preimage verifies through accepted signer binding`);
    check(verified.status !== "valid_signature" || verified.binding.preimage_sha256_hex.length === 64, "valid result is preimage-bound");
    const wrong = Uint8Array.from(preimage); wrong[wrong.length - 1] ^= 1;
    equal((await provider.verify({ signer, preimage: wrong, signature_bytes: signed.signature_bytes })).status, "invalid_signature", "wrong preimage fails");
    signed.signature_bytes.fill(0);
    equal((await provider.sign({ key: signing.handle, preimage })).signature_bytes.length, 64, "mutating returned signature cannot affect key state");
  }
  equal((await provider.verify({ signer, preimage: new Uint8Array(), signature_bytes: new Uint8Array(63) })).reason, "malformed", "truncated signature is malformed");
  await rejects(() => registry.adoptRecipientKeyPair(recipientId, /** @type {CryptoKeyPair} */ ({ privateKey: signingPair, publicKey: recipientPair.publicKey })),
    (error) => error?.code === "invalid_key");
  const extractablePair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  await rejects(() => registry.adoptRecipientKeyPair(recipientId, extractablePair), (error) => error?.code === "private_key_unexpectedly_extractable");
}

async function testHpke() {
  const registry = new Hc2NativeKeyRegistry();
  const recipient = await registry.generateRecipientKeyPair(entity("public-key", "f"));
  const wrongRecipient = await registry.generateRecipientKeyPair(entity("public-key", "g"));
  const directions = [];
  const provider = new SingleShotHpkeProvider({ keys: registry, on_context_created: (direction) => directions.push(direction) });
  const plaintext = new TextEncoder().encode("Patchmark HC-2 single-shot HPKE");
  const binding = hpkeInfoBinding();
  const info = buildHpkeInfo(binding);
  let finalizerCalls = 0;
  let finalizerEnc = null;
  let header = null;
  const sealed = await provider.sealBound({
    recipient_public_key: recipient.public_key,
    info,
    plaintext,
    finalize_aad(enc) {
      finalizerCalls += 1;
      finalizerEnc = Uint8Array.from(enc);
      header = envelopeHeader(binding, enc, plaintext.length + 16);
      const bound = buildBoundHpkeAad(header);
      enc.fill(0);
      return bound;
    }
  });
  equal(finalizerCalls, 1, "AAD finalizer is invoked exactly once");
  equal(sealed.encapsulated_key_bytes.length, 32, "HPKE enc has exact length");
  equal(sealed.ciphertext_bytes.length, plaintext.length + 16, "HPKE ciphertext includes one tag");
  equal(toHex(finalizerEnc), toHex(sealed.encapsulated_key_bytes), "AAD finalizer receives an exact copy of returned enc");
  equal(toHex(header.encapsulated_key_bytes), toHex(sealed.encapsulated_key_bytes), "final canonical header embeds the returned enc exactly");
  check(finalizerEnc !== sealed.encapsulated_key_bytes && header.encapsulated_key_bytes !== sealed.encapsulated_key_bytes, "enc trust-boundary copies do not alias");
  const opened = await provider.openBound({ recipient_key_pair: recipient, info, public_header: header, ciphertext_bytes: sealed.ciphertext_bytes });
  equal(opened.status, "opened", "single-shot ciphertext opens");
  if (opened.status === "opened") equal(toHex(opened.plaintext), toHex(plaintext), "opened plaintext is exact");
  equal(provider.evidence(), { sender_contexts_created: 1, recipient_contexts_created: 1, sender_seal_calls: 1, recipient_open_calls: 1 }, "operation evidence counts one fresh context per call");
  equal(directions, ["sender", "recipient"], "context instrumentation observes both directions");

  const wrongInfo = Uint8Array.from(info); wrongInfo[0] ^= 1;
  const contextsBeforeWrongInfo = provider.evidence().sender_contexts_created;
  await rejects(() => provider.sealBound({ recipient_public_key: recipient.public_key, info: wrongInfo, plaintext, finalize_aad: () => { throw new Error("must not run"); } }), (error) => error?.code === "invalid_binding");
  equal(provider.evidence().sender_contexts_created, contextsBeforeWrongInfo, "malformed info is rejected before sender setup");

  const authenticationCases = [
    ["ciphertext", header, flipped(sealed.ciphertext_bytes), recipient, info],
    ["enc", { ...header, encapsulated_key_bytes: flipped(header.encapsulated_key_bytes) }, sealed.ciphertext_bytes, recipient, info],
    ["wrong recipient", header, sealed.ciphertext_bytes, wrongRecipient, info],
    ["wrong info", header, sealed.ciphertext_bytes, recipient, buildHpkeInfo({ ...binding, envelope_id: "b".repeat(25) + "a" })],
    ["envelope id", { ...header, envelope_id: "b".repeat(25) + "a" }, sealed.ciphertext_bytes, recipient, info],
    ["routing tag", { ...header, recipient_routing_tag: flipped(header.recipient_routing_tag) }, sealed.ciphertext_bytes, recipient, info],
    ["chunk ordinal", { ...header, chunk_ordinal: 1 }, sealed.ciphertext_bytes, recipient, info],
    ["chunk count", { ...header, chunk_count: 3 }, sealed.ciphertext_bytes, recipient, info]
  ];
  for (const [name, mutatedHeader, ciphertext, selectedRecipient, selectedInfo] of authenticationCases) {
    const result = await provider.openBound({ recipient_key_pair: selectedRecipient, info: selectedInfo, public_header: mutatedHeader, ciphertext_bytes: ciphertext });
    equal(result, { status: "rejected", reason: "authentication_failed" }, `${name} collapses to authenticated rejection`);
  }
  for (const [name, malformedHeader, ciphertext] of [
    ["magic", { ...header, magic: "WRONG" }, sealed.ciphertext_bytes],
    ["version", { ...header, envelope_version: 2 }, sealed.ciphertext_bytes],
    ["suite", { ...header, suite_id: "patchmark/hc2/crypto-suite/v0" }, sealed.ciphertext_bytes],
    ["ciphertext length", { ...header, ciphertext_length: header.ciphertext_length + 1n }, sealed.ciphertext_bytes],
    ["missing enc", withoutEnc(header), sealed.ciphertext_bytes],
    ["wrong-length enc", { ...header, encapsulated_key_bytes: new Uint8Array(31) }, sealed.ciphertext_bytes],
    ["duplicate enc field", { ...header, duplicate_encapsulated_key_bytes: header.encapsulated_key_bytes }, sealed.ciphertext_bytes],
    ["truncated ciphertext", header, new Uint8Array(15)]
  ]) {
    equal((await provider.openBound({ recipient_key_pair: recipient, info, public_header: malformedHeader, ciphertext_bytes: ciphertext })).reason,
      "malformed", `${name} fails closed as malformed`);
  }
  equal((await provider.openBound({ recipient_key_pair: /** @type {any} */ (recipient.private_key), info, public_header: header, ciphertext_bytes: sealed.ciphertext_bytes })).reason, "malformed", "private-only handle is rejected");

  for (const [name, finalizer] of [
    ["placeholder enc", (enc) => buildBoundHpkeAad(envelopeHeader(binding, new Uint8Array(enc.length), plaintext.length + 16))],
    ["different enc", (enc) => buildBoundHpkeAad(envelopeHeader(binding, flipped(enc), plaintext.length + 16))],
    ["missing enc", (enc) => buildBoundHpkeAad(withoutEnc(envelopeHeader(binding, enc, plaintext.length + 16)))],
    ["duplicated enc", (enc) => buildBoundHpkeAad({ ...envelopeHeader(binding, enc, plaintext.length + 16), duplicate_encapsulated_key_bytes: enc })],
    ["wrong-length enc", (enc) => buildBoundHpkeAad(envelopeHeader(binding, enc.slice(0, -1), plaintext.length + 16))],
    ["wrong suite", (enc) => buildBoundHpkeAad({ ...envelopeHeader(binding, enc, plaintext.length + 16), suite_id: "patchmark/hc2/crypto-suite/v0" })],
    ["unknown field", (enc) => buildBoundHpkeAad({ ...envelopeHeader(binding, enc, plaintext.length + 16), unknown: true })],
    ["throwing", () => { throw new Error("secret finalizer failure"); }],
    ["asynchronous", async (enc) => buildBoundHpkeAad(envelopeHeader(binding, enc, plaintext.length + 16))],
    ["thenable", () => ({ then() {}, bytes: new Uint8Array() })],
    ["unbranded", (enc) => buildEnvelopeAad(envelopeHeader(binding, enc, plaintext.length + 16))],
    ["malformed", () => new Uint8Array([1, 2, 3])],
    ["oversized", () => new Uint8Array(4097)]
  ]) {
    const sealsBefore = provider.evidence().sender_seal_calls;
    await rejects(() => provider.sealBound({ recipient_public_key: recipient.public_key, info, plaintext, finalize_aad: finalizer }),
      (error) => error?.code === "invalid_binding" && !error.message.includes("secret"));
    equal(provider.evidence().sender_seal_calls, sealsBefore, `${name} finalizer returns no ciphertext and never seals`);
  }

  const operations = 16;
  const contextsBeforeConcurrency = provider.evidence().sender_contexts_created;
  const headers = [];
  const seals = await Promise.all(Array.from({ length: operations }, (_, index) => provider.sealBound({
    recipient_public_key: recipient.public_key,
    info,
    plaintext,
    finalize_aad(enc) {
      const concurrentHeader = envelopeHeader(binding, enc, plaintext.length + 16);
      headers[index] = concurrentHeader;
      return buildBoundHpkeAad(concurrentHeader);
    }
  })));
  equal(provider.evidence().sender_contexts_created - contextsBeforeConcurrency, operations, "sixteen concurrent seals create sixteen fresh sender contexts");
  const opens = await Promise.all(seals.map((entry, index) => provider.openBound({ recipient_key_pair: recipient, info, public_header: headers[index], ciphertext_bytes: entry.ciphertext_bytes })));
  equal(opens.filter((entry) => entry.status === "opened").length, operations, "all concurrent single-shot opens succeed");
  equal(new Set(headers.map((entry) => toHex(entry.encapsulated_key_bytes))).size, operations, "concurrent operation evidence contains sixteen independently produced encapsulations");
  const original = seals[0].ciphertext_bytes[0];
  seals[1].ciphertext_bytes[0] ^= 1;
  equal(seals[0].ciphertext_bytes[0], original, "returned ciphertext buffers do not alias");

  const mutablePlaintext = new TextEncoder().encode("Patchmark HC-2 mutable input!!");
  const mutableBinding = hpkeInfoBinding("c");
  const mutableInfo = buildHpkeInfo(mutableBinding);
  const mutableRecipient = Uint8Array.from(recipient.public_key);
  const expectedPlaintext = Uint8Array.from(mutablePlaintext);
  let mutableHeader = null;
  const pendingSeal = provider.sealBound({ recipient_public_key: mutableRecipient, info: mutableInfo, plaintext: mutablePlaintext, finalize_aad(enc) {
    mutableHeader = envelopeHeader(mutableBinding, enc, expectedPlaintext.length + 16);
    return buildBoundHpkeAad(mutableHeader);
  } });
  mutablePlaintext.fill(0); mutableRecipient.fill(0); mutableInfo.fill(0);
  const mutationSealed = await pendingSeal;
  const mutationOpened = await provider.openBound({ recipient_key_pair: recipient, info: buildHpkeInfo(mutableBinding), public_header: mutableHeader, ciphertext_bytes: mutationSealed.ciphertext_bytes });
  equal(mutationOpened.status === "opened" ? toHex(mutationOpened.plaintext) : mutationOpened.status, toHex(expectedPlaintext), "inputs are copied before the first asynchronous boundary");

  const originalCreateSender = CipherSuite.prototype.createSenderContext;
  const originalCreateRecipient = CipherSuite.prototype.createRecipientContext;
  try {
    CipherSuite.prototype.createSenderContext = async () => { throw new Error("secret sender failure"); };
    await rejects(() => provider.sealBound({ recipient_public_key: recipient.public_key, info, plaintext, finalize_aad: (enc) => buildBoundHpkeAad(envelopeHeader(binding, enc, plaintext.length + 16)) }),
      (error) => error?.code === "provider_unavailable" && !error.message.includes("secret"));
    let failedSealCalls = 0;
    let failedFinalizerCalls = 0;
    CipherSuite.prototype.createSenderContext = async () => ({ enc: new Uint8Array(32).fill(7).buffer, seal: async () => { failedSealCalls += 1; throw new Error("secret sealing failure"); } });
    const senderCallsBeforeFailure = provider.evidence().sender_seal_calls;
    await rejects(() => provider.sealBound({ recipient_public_key: recipient.public_key, info, plaintext, finalize_aad: (enc) => {
      failedFinalizerCalls += 1; return buildBoundHpkeAad(envelopeHeader(binding, enc, plaintext.length + 16));
    } }),
      (error) => error?.code === "provider_unavailable" && !error.message.includes("secret"));
    equal(failedFinalizerCalls, 1, "failed seal finalizes AAD once");
    equal(failedSealCalls, 1, "failed underlying seal is invoked once without retry");
    equal(provider.evidence().sender_seal_calls - senderCallsBeforeFailure, 1, "failed context is marked consumed before asynchronous seal");
    CipherSuite.prototype.createRecipientContext = async () => { throw new Error("secret recipient failure"); };
    equal(await provider.openBound({ recipient_key_pair: recipient, info, public_header: header, ciphertext_bytes: sealed.ciphertext_bytes }),
      { status: "rejected", reason: "authentication_failed" }, "recipient context creation failure is non-oracular");
    CipherSuite.prototype.createRecipientContext = async () => ({ open: async () => { throw new Error("secret opening failure"); } });
    equal(await provider.openBound({ recipient_key_pair: recipient, info, public_header: header, ciphertext_bytes: sealed.ciphertext_bytes }),
      { status: "rejected", reason: "authentication_failed" }, "opening failure is non-oracular");
  } finally {
    CipherSuite.prototype.createSenderContext = originalCreateSender;
    CipherSuite.prototype.createRecipientContext = originalCreateRecipient;
  }
}

async function testRecovery() {
  equal(HC2_RECOVERY_PARAMETER_VERSION, 1, "recovery parameters are versioned");
  equal(HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES, 64 * 1024 * 1024, "recovery memory is exactly 64 MiB");
  equal(HC2_RECOVERY_ARGON2_OPSLIMIT, 3, "recovery operations are frozen");
  equal(HC2_RECOVERY_DERIVED_KEY_BYTES, 32, "recovery key is 256 bits");
  const workers = [];
  const random = new FixtureRandomSource();
  const protector = new WorkerRecoveryProtector({ random, worker_factory: () => {
    const worker = new LocalOneShotWorker(); workers.push(worker); return worker;
  } });
  const person = entity("person", "h");
  const protectCapability = Object.freeze({ scope: "root_ceremony_only", person_id: person });
  const unlockCapability = Object.freeze({ scope: "recovery_ceremony_only", person_id: person });
  const payload = new TextEncoder().encode("future recovery ceremony material");
  const password = new TextEncoder().encode("correct horse battery staple");
  const protectedResult = await protector.protect({ capability: protectCapability, recovery_payload: payload, password_material: password });
  equal(protectedResult.suite_id, HC2_CRYPTO_SUITE_ID, "recovery output is bound to exact suite");
  const record = decodeRecoveryProtectedRecord(protectedResult.protected_bytes);
  equal(record.ciphertext.length, payload.length + 16, "recovery ciphertext includes exact tag");
  check(workers[0].terminated, "protect worker terminates");
  const opened = await protector.unlock({ capability: unlockCapability, protected_bytes: protectedResult.protected_bytes, password_material: password });
  equal(opened.status, "unlocked", "recovery record unlocks");
  if (opened.status === "unlocked") equal(new TextDecoder().decode(opened.ceremony_payload), new TextDecoder().decode(payload), "recovery plaintext is exact");
  check(workers[1].terminated && protector.evidence()?.worker_terminated, "unlock worker terminates and emits evidence");
  for (const invalid of [
    { label: "wrong password", bytes: protectedResult.protected_bytes, password: new TextEncoder().encode("wrong") },
    { label: "corrupt ciphertext", bytes: flipped(protectedResult.protected_bytes), password },
    { label: "truncation", bytes: protectedResult.protected_bytes.slice(0, -1), password },
    { label: "unknown parameters", bytes: mutateRecoveryParameter(protectedResult.protected_bytes), password }
  ]) {
    const result = await protector.unlock({ capability: unlockCapability, protected_bytes: invalid.bytes, password_material: invalid.password });
    equal(result, { status: "rejected", reason: "wrong_password" }, `${invalid.label} has the identical public failure`);
  }
  const otherPersonResult = await protector.unlock({ capability: { ...unlockCapability, person_id: entity("person", "i") }, protected_bytes: protectedResult.protected_bytes, password_material: password });
  equal(otherPersonResult, { status: "rejected", reason: "wrong_password" }, "wrong AAD/person has identical public failure");
  const aborted = new AbortController(); aborted.abort();
  await rejects(() => protector.protectWithSignal({ capability: protectCapability, recovery_payload: payload, password_material: password }, aborted.signal),
    (error) => error?.code === "operation_aborted" && !error.message.includes("password"));
  await rejects(() => new WorkerRecoveryProtector({ random, worker_factory: () => { throw new Error("worker secret detail"); } }).protect({ capability: protectCapability, recovery_payload: payload, password_material: password }),
    (error) => error?.code === "provider_unavailable" && !error.message.includes("secret"));
  const failingProtector = new WorkerRecoveryProtector({ random, worker_factory: () => new FailingWorker() });
  await rejects(() => failingProtector.protect({ capability: protectCapability, recovery_payload: payload, password_material: password }), (error) => error?.code === "provider_unavailable");
  check(failingProtector.evidence()?.worker_terminated, "failed worker is still terminated");
  equal(buildRecoveryAad(record).length > 0, true, "recovery AAD is exact and nonempty");
}

function testSuiteNegotiation() {
  const all = { secure_random: true, ed25519: true, x25519: true, hpke_base_x25519_hkdf_sha256_aes256gcm: true, argon2id: true, xchacha20_poly1305: true };
  const negotiator = new ExactHc2SuiteNegotiator(all);
  const selected = negotiator.negotiate([HC2_CRYPTO_SUITE_ID]);
  equal(selected.status, "selected", "exact suite is selected");
  check(Object.isFrozen(selected) && Object.isFrozen(selected.suite) && Object.isFrozen(selected.bindings), "suite selection is transitively immutable at provider boundary");
  for (const offer of [[], ["x25519"], [HC2_CRYPTO_SUITE_ID, HC2_CRYPTO_SUITE_ID], ["patchmark/hc2/crypto-suite/v0"], [HC2_CRYPTO_SUITE_ID + "/aes128"]]) {
    equal(negotiator.negotiate(offer), { status: "rejected", reason: "no_exact_supported_suite" }, "partial, reordered, duplicate, and downgrade offers fail closed");
  }
  for (const component of Object.keys(all)) {
    const capabilities = { ...all, [component]: false };
    assertions += 1;
    assert.throws(() => new ExactHc2SuiteNegotiator(capabilities).negotiate([HC2_CRYPTO_SUITE_ID]), (error) => error?.code === "unsupported_platform");
  }
  equal(selected.bindings.recovery_parameter_version, 1, "suite selection binds recovery parameters");
}

class FixtureRandomSource {
  #counter = 1;
  async randomBytes(length) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (this.#counter + index) & 0xff;
    this.#counter += length;
    return bytes;
  }
}

class LocalOneShotWorker {
  listeners = new Map();
  terminated = false;
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  postMessage(request) {
    void performRecoveryWorkerOperation(request).then((response) => this.listeners.get("message")?.({ data: response }));
  }
  terminate() { this.terminated = true; }
}

class FailingWorker extends LocalOneShotWorker {
  postMessage() { queueMicrotask(() => this.listeners.get("error")?.({})); }
}

function hpkeSuite() {
  return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
}

function hpkeInfoBinding(fill = "a") {
  return {
    envelope_version: 1,
    suite_id: HC2_CRYPTO_SUITE_ID,
    envelope_id: fill.repeat(25) + "a",
    recipient_routing_tag: new Uint8Array(32),
    chunk_ordinal: 0,
    chunk_count: 2
  };
}

function envelopeHeader(binding, encapsulatedKeyBytes, ciphertextLength) {
  return {
    magic: HC2_ENVELOPE_MAGIC,
    ...binding,
    encapsulated_key_bytes: Uint8Array.from(encapsulatedKeyBytes),
    ciphertext_length: BigInt(ciphertextLength)
  };
}

function withoutEnc(header) {
  const copy = { ...header };
  delete copy.encapsulated_key_bytes;
  return copy;
}

function mutateRecoveryParameter(bytes) {
  const copy = Uint8Array.from(bytes);
  const needle = new TextEncoder().encode("patchmark/hc2/crypto-suite/v1");
  for (let index = 0; index <= copy.length - needle.length; index += 1) {
    if (needle.every((byte, offset) => copy[index + offset] === byte)) { copy[index + needle.length - 1] ^= 1; return copy; }
  }
  throw new Error("suite marker not found");
}

function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function flipped(value) { const copy = Uint8Array.from(value); copy[copy.length - 1] ^= 1; return copy; }
function hex(value) { return Uint8Array.from(Buffer.from(value, "hex")); }
function concatHex(prefix, body) { return hex(prefix + body); }
function toHex(value) { return Buffer.from(value).toString("hex"); }

await testRandom();
await testStandardsVectors();
await testNativeKeysAndSignatures();
await testHpke();
await testRecovery();
testSuiteNegotiation();

process.stdout.write(`${JSON.stringify({
  assertions,
  fixture_version: fixture.fixture_version,
  providers: ["secure-random", "ed25519", "x25519", "hpke", "argon2id-xchacha20poly1305", "suite-negotiation"],
  hpke_context_policy: "internal-setup-bound-finalizer-fresh-and-structurally-single-use",
  recovery_worker_policy: "one-explicit-operation-then-terminate",
  official_vector_families: 5
}, null, 2)}\n`);

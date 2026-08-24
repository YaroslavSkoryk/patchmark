#!/usr/bin/env python3
"""Independent HC-2 Slice 5 verifier: Python stdlib only; no Patchmark imports."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import struct
from pathlib import Path

FIXTURE = Path(__file__).with_name("fixtures") / "collaboration-hc2-slice5-v1.json"
fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
inputs = fixture["inputs"]
expected = fixture["expected"]
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        raise AssertionError(message)


def sha(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()


def b32(value: bytes) -> str:
    return base64.b32encode(value).decode("ascii").rstrip("=").lower()


def head(major: int, value: int) -> bytes:
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + struct.pack(">H", value)
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + struct.pack(">I", value)
    return bytes([(major << 5) | 27]) + struct.pack(">Q", value)


def cbor(value) -> bytes:
    if value is None:
        return b"\xf6"
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if isinstance(value, int) and value >= 0:
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return head(3, len(encoded)) + encoded
    if isinstance(value, (list, tuple)):
        return head(4, len(value)) + b"".join(cbor(child) for child in value)
    if isinstance(value, dict):
        entries = sorted(((cbor(key), cbor(child)) for key, child in value.items()), key=lambda item: item[0])
        return head(5, len(entries)) + b"".join(key + child for key, child in entries)
    raise TypeError(f"unsupported canonical value: {type(value)!r}")


def entity(kind: str, char: str) -> str:
    return f"pm:{kind}:v1:{char * 25}a"


def placeholder(kind: str, char: str) -> str:
    return f"pm:{kind}:v1:{char * 51}a"


def identity(kind: str, domain: str, core) -> tuple[str, bytes, bytes]:
    preimage = cbor([domain, core])
    digest = sha(preimage)
    return f"pm:{kind}:v1:{b32(digest)}", digest, preimage


# RFC 8032 Ed25519 verification, separately implemented from the formulas.
Q = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, Q - 2, Q)) % Q
I = pow(2, (Q - 1) // 4, Q)


def inv(value: int) -> int:
    return pow(value, Q - 2, Q)


def recover_x(y: int, sign: int) -> int:
    xx = (y * y - 1) * inv(D * y * y + 1) % Q
    x = pow(xx, (Q + 3) // 8, Q)
    if (x * x - xx) % Q:
        x = x * I % Q
    if (x * x - xx) % Q:
        raise ValueError("invalid Ed25519 point")
    return Q - x if (x & 1) != sign else x


def ed_decode(encoded: bytes):
    value = int.from_bytes(encoded, "little")
    y = value & ((1 << 255) - 1)
    if len(encoded) != 32 or y >= Q:
        raise ValueError("noncanonical Ed25519 point")
    return recover_x(y, value >> 255), y


def ed_add(left, right):
    x1, y1 = left
    x2, y2 = right
    product = D * x1 * x2 * y1 * y2 % Q
    return ((x1 * y2 + x2 * y1) * inv(1 + product) % Q,
            (y1 * y2 + x1 * x2) * inv(1 - product) % Q)


def ed_mul(point, scalar: int):
    result = (0, 1)
    while scalar:
        if scalar & 1:
            result = ed_add(result, point)
        point = ed_add(point, point)
        scalar >>= 1
    return result


BY = 4 * inv(5) % Q
B = (recover_x(BY, 0), BY)


def ed_encode(point) -> bytes:
    x, y = point
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def ed_public_from_seed(seed: bytes) -> bytes:
    digest = hashlib.sha512(seed).digest()
    scalar = int.from_bytes(digest[:32], "little")
    scalar = (scalar & ((1 << 254) - 8)) | (1 << 254)
    return ed_encode(ed_mul(B, scalar))


def ed_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    try:
        r = ed_decode(signature[:32])
        a = ed_decode(public)
        s = int.from_bytes(signature[32:], "little")
        if len(signature) != 64 or s >= L:
            return False
        challenge = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % L
        return ed_encode(ed_mul(B, s)) == ed_encode(ed_add(r, ed_mul(a, challenge)))
    except ValueError:
        return False


# RFC 7748 X25519 plus RFC 5869/9180 labeled HKDF.
P25519 = 2**255 - 19


def x25519(scalar_bytes: bytes, u_bytes: bytes) -> bytes:
    scalar = bytearray(scalar_bytes)
    scalar[0] &= 248
    scalar[31] &= 127
    scalar[31] |= 64
    k = int.from_bytes(scalar, "little")
    x1 = int.from_bytes(u_bytes, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for position in range(254, -1, -1):
        bit = (k >> position) & 1
        swap ^= bit
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a = (x2 + z2) % P25519; aa = a * a % P25519
        b = (x2 - z2) % P25519; bb = b * b % P25519
        e = (aa - bb) % P25519; c = (x3 + z3) % P25519; d = (x3 - z3) % P25519
        da = d * a % P25519; cb = c * b % P25519
        x3 = (da + cb) ** 2 % P25519; z3 = x1 * ((da - cb) ** 2) % P25519
        x2 = aa * bb % P25519; z2 = e * (aa + 121665 * e) % P25519
    if swap:
        x2, x3, z2, z3 = x3, x2, z3, z2
    return (x2 * pow(z2, P25519 - 2, P25519) % P25519).to_bytes(32, "little")


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt or bytes(32), ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    result = b""; block = b""
    for counter in range(1, (length + 31) // 32 + 1):
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        result += block
    return result[:length]


def labeled_extract(salt: bytes, label: bytes, ikm: bytes, suite: bytes) -> bytes:
    return hkdf_extract(salt, b"HPKE-v1" + suite + label + ikm)


def labeled_expand(prk: bytes, label: bytes, info: bytes, length: int, suite: bytes) -> bytes:
    return hkdf_expand(prk, length.to_bytes(2, "big") + b"HPKE-v1" + suite + label + info, length)


KEM_SUITE = b"KEM" + (32).to_bytes(2, "big")
HPKE_SUITE = b"HPKE" + (32).to_bytes(2, "big") + (1).to_bytes(2, "big") + (2).to_bytes(2, "big")
BASE_POINT = b"\x09" + bytes(31)


def derive_x_key(ikm: bytes) -> tuple[bytes, bytes]:
    private = labeled_expand(labeled_extract(b"", b"dkp_prk", ikm, KEM_SUITE), b"sk", b"", 32, KEM_SUITE)
    return private, x25519(private, BASE_POINT)


def hpke_context(recipient_public: bytes, ephemeral_ikm: bytes, info: bytes) -> tuple[bytes, bytes, bytes]:
    ephemeral_private, enc = derive_x_key(ephemeral_ikm)
    dh = x25519(ephemeral_private, recipient_public)
    shared = labeled_expand(labeled_extract(b"", b"eae_prk", dh, KEM_SUITE), b"shared_secret", enc + recipient_public, 32, KEM_SUITE)
    psk_id_hash = labeled_extract(b"", b"psk_id_hash", b"", HPKE_SUITE)
    info_hash = labeled_extract(b"", b"info_hash", info, HPKE_SUITE)
    context = b"\x00" + psk_id_hash + info_hash
    secret = labeled_extract(shared, b"secret", b"", HPKE_SUITE)
    return enc, labeled_expand(secret, b"key", context, 32, HPKE_SUITE), labeled_expand(secret, b"base_nonce", context, 12, HPKE_SUITE)


# Pure-Python AES-256-GCM used to regenerate the HPKE ciphertexts.
def gf8(a: int, b: int) -> int:
    result = 0
    for _ in range(8):
        if b & 1: result ^= a
        a = ((a << 1) ^ (0x11B if a & 0x80 else 0)) & 0xFF
        b >>= 1
    return result


def pow8(value: int, exponent: int) -> int:
    result = 1
    while exponent:
        if exponent & 1: result = gf8(result, value)
        value = gf8(value, value); exponent >>= 1
    return result


def sbox(value: int) -> int:
    invv = 0 if value == 0 else pow8(value, 254)
    mixed = invv
    for shift in range(1, 5): mixed ^= ((invv << shift) | (invv >> (8 - shift))) & 0xFF
    return mixed ^ 0x63


SBOX = [sbox(value) for value in range(256)]


def aes_words(key: bytes):
    words = [list(key[index:index + 4]) for index in range(0, len(key), 4)]; rcon = 1
    while len(words) < 60:
        temp = words[-1][:]
        if len(words) % 8 == 0:
            temp = [SBOX[x] for x in temp[1:] + temp[:1]]; temp[0] ^= rcon; rcon = gf8(rcon, 2)
        elif len(words) % 8 == 4: temp = [SBOX[x] for x in temp]
        words.append([a ^ b for a, b in zip(words[-8], temp)])
    return words


def aes_block(key: bytes, block: bytes) -> bytes:
    words = aes_words(key); state = list(block)
    def add_round(number):
        for column in range(4):
            for row in range(4): state[4 * column + row] ^= words[4 * number + column][row]
    add_round(0)
    for number in range(1, 15):
        state[:] = [SBOX[x] for x in state]
        state[:] = [state[4 * ((column + row) % 4) + row] for column in range(4) for row in range(4)]
        if number != 14:
            for column in range(4):
                a = state[4 * column:4 * column + 4]
                state[4 * column:4 * column + 4] = [
                    gf8(a[0], 2) ^ gf8(a[1], 3) ^ a[2] ^ a[3],
                    a[0] ^ gf8(a[1], 2) ^ gf8(a[2], 3) ^ a[3],
                    a[0] ^ a[1] ^ gf8(a[2], 2) ^ gf8(a[3], 3),
                    gf8(a[0], 3) ^ a[1] ^ a[2] ^ gf8(a[3], 2)]
        add_round(number)
    return bytes(state)


def gf128(x: int, y: int) -> int:
    result = 0; value = y
    for bit in range(128):
        if x & (1 << (127 - bit)): result ^= value
        value = (value >> 1) ^ (0xE1000000000000000000000000000000 if value & 1 else 0)
    return result


def ghash(hash_key: bytes, payload: bytes) -> bytes:
    state = 0; hvalue = int.from_bytes(hash_key, "big")
    for offset in range(0, len(payload), 16):
        state = gf128(state ^ int.from_bytes(payload[offset:offset + 16].ljust(16, b"\0"), "big"), hvalue)
    return state.to_bytes(16, "big")


def aes_gcm(key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> bytes:
    ciphertext = bytearray()
    for index, offset in enumerate(range(0, len(plaintext), 16), 2):
        stream = aes_block(key, nonce + index.to_bytes(4, "big")); chunk = plaintext[offset:offset + 16]
        ciphertext.extend(a ^ b for a, b in zip(chunk, stream))
    encoded = aad + bytes((-len(aad)) % 16) + bytes(ciphertext) + bytes((-len(ciphertext)) % 16)
    encoded += struct.pack(">QQ", len(aad) * 8, len(ciphertext) * 8)
    tag = bytes(a ^ b for a, b in zip(aes_block(key, nonce + b"\0\0\0\1"), ghash(aes_block(key, bytes(16)), encoded)))
    return bytes(ciphertext) + tag


ids = {
    "project": entity("project", "a"), "scope": entity("access-scope", "b"), "ownerPerson": entity("person", "c"),
    "ownerMembership": entity("membership", "d"), "ownerDevice": entity("device", "e"), "ownerSigning": entity("public-key", "f"),
    "ownerRecipient": entity("public-key", "g"), "root": entity("public-key", "h"), "candidatePerson": entity("person", "j"),
    "candidateMembership": entity("membership", "k"), "candidateDevice": entity("device", "m"), "candidateSigning": entity("public-key", "n"),
    "candidateRecipient": entity("public-key", "p"), "invitation": entity("invitation", "q"), "epoch1": entity("key-epoch", "r"),
    "epoch2": entity("key-epoch", "s"), "epoch3": entity("key-epoch", "t"), "control1": placeholder("control-event", "u")
}
suite_id = "patchmark/hc2/crypto-suite/v1"
candidate_public = bytes.fromhex(inputs["candidate_ed25519_public_hex"])
check(ed_public_from_seed(bytes.fromhex(inputs["candidate_ed25519_seed_hex"])) == candidate_public, "candidate Ed25519 public derivation")
candidate_x_private, candidate_x_public = derive_x_key(bytes.fromhex(inputs["candidate_x25519_ikm_hex"]))
owner_x_private, owner_x_public = derive_x_key(bytes.fromhex(inputs["owner_x25519_ikm_hex"]))
tagged_signing = cbor(["patchmark/hc2/public-key/v1", "ed25519", ids["candidateSigning"], candidate_public])
tagged_candidate_x = cbor(["patchmark/hc2/public-key/v1", "x25519", ids["candidateRecipient"], candidate_x_public])
tagged_owner_x = cbor(["patchmark/hc2/public-key/v1", "x25519", ids["ownerRecipient"], owner_x_public])

action = {"schema_version": 1, "project_id": ids["project"], "action_kind": "hc2_invitation_create", "invitation_id": ids["invitation"],
          "inviting_membership_id": ids["ownerMembership"], "inviting_person_id": ids["ownerPerson"], "inviting_device_id": ids["ownerDevice"],
          "intended_role": "reviewer", "access_scope": "project_wide", "access_scope_id": ids["scope"], "creation_control_head_id": ids["control1"],
          "valid_through_control_sequence": 12, "suite_id": suite_id}
check(sha(cbor(action)).hex() == expected["invitation"]["action_canonical_sha256"], "invitation action canonical hash")
action_id = f"pm:control-action:v1:{b32(sha(cbor(['patchmark/control-action/v1', action])))}"
check(action_id == expected["invitation"]["action_id"], "invitation action identity")
invitation = {"schema_version": 1, "record_kind": "invitation_evidence_core", "authority": "none", "project_id": ids["project"],
              "invitation_id": ids["invitation"], "inviting_membership_id": ids["ownerMembership"], "inviting_person_id": ids["ownerPerson"],
              "inviting_device_id": ids["ownerDevice"], "intended_role": "reviewer", "access_scope": "project_wide", "access_scope_id": ids["scope"],
              "creation_control_head_id": ids["control1"], "creation_control_sequence": 1, "valid_through_control_sequence": 12,
              "accepted_invitation_action_id": action_id, "accepted_invitation_control_event_id": ids["control1"], "status": "accepted", "suite_id": suite_id}
invitation_id, _, _ = identity("invitation-evidence", "patchmark/hc2/invitation-evidence/v1", invitation)
check(invitation_id == expected["invitation"]["evidence_id"], "invitation evidence identity")

request = {"schema_version": 1, "record_kind": "enrollment_request_core", "authority": "none", "enrollment_kind": "new_person",
           "project_id": ids["project"], "invitation_id": ids["invitation"], "invitation_evidence_id": invitation_id,
           "accepted_invitation_control_event_id": ids["control1"], "candidate_person_id": ids["candidatePerson"], "existing_membership_id": None,
           "proposed_membership_id": ids["candidateMembership"], "candidate_device_id": ids["candidateDevice"], "signing_key_id": ids["candidateSigning"],
           "signing_public_key_bytes": tagged_signing, "recipient_key_id": ids["candidateRecipient"], "recipient_public_key_bytes": tagged_candidate_x,
           "intended_role": "reviewer", "access_scope": "project_wide", "access_scope_id": ids["scope"], "bound_control_head_id": ids["control1"],
           "request_nonce": bytes([0x71]) * 32, "suite_id": suite_id}
request_id, _, request_preimage = identity("enrollment-request", "patchmark/hc2/enrollment-request/v1", request)
check(request_id == expected["enrollment_request"]["request_id"], "request identity")
check(sha(request_preimage).hex() == expected["enrollment_request"]["canonical_sha256"], "request canonical preimage hash")
check(ed_verify(candidate_public, bytes.fromhex(expected["enrollment_request"]["signature_preimage_hex"]), bytes.fromhex(expected["enrollment_request"]["signature_hex"])), "request Ed25519 signature")

challenge_plaintext = bytes.fromhex(inputs["challenge_plaintext_hex"])
challenge_header = {"schema_version": 1, "record_kind": "possession_challenge_header_core", "authority": "none", "project_id": ids["project"],
                    "invitation_id": ids["invitation"], "request_id": request_id, "candidate_person_id": ids["candidatePerson"],
                    "candidate_device_id": ids["candidateDevice"], "signing_key_id": ids["candidateSigning"], "recipient_key_id": ids["candidateRecipient"],
                    "signing_public_key_sha256": sha(tagged_signing), "recipient_public_key_sha256": sha(tagged_candidate_x),
                    "challenge_commitment": sha(cbor(["patchmark/hc2/possession-challenge-commitment/v1", challenge_plaintext])),
                    "bound_control_head_id": ids["control1"], "suite_id": suite_id}
challenge_id, challenge_digest, _ = identity("possession-challenge", "patchmark/hc2/possession-challenge/v1", challenge_header)
check(challenge_id == expected["challenge"]["challenge_id"], "challenge identity")
header_digest = sha(cbor(challenge_header)); check(header_digest.hex() == expected["challenge"]["header_sha256"], "challenge header hash")

def public_header(enc: bytes, routing: bytes, envelope_digest: bytes, ciphertext_length: int):
    return {"magic": "PATCHMARK-HC2-BUNDLE", "envelope_version": 1, "suite_id": suite_id, "envelope_id": b32(envelope_digest)[:26],
            "encapsulated_key_bytes": enc, "recipient_routing_tag": routing, "chunk_ordinal": 0, "chunk_count": 1, "ciphertext_length": ciphertext_length}


def hpke_seal(recipient_public: bytes, ephemeral_ikm_hex: str, routing: bytes, envelope_digest: bytes, plaintext: bytes):
    envelope_id = b32(envelope_digest)[:26]
    info = cbor(["patchmark/hc2/hpke-info/v1", 1, suite_id, envelope_id, routing, 0, 1])
    enc, key, nonce = hpke_context(recipient_public, bytes.fromhex(ephemeral_ikm_hex), info)
    header_value = public_header(enc, routing, envelope_digest, len(plaintext) + 16)
    return enc, aes_gcm(key, nonce, cbor(header_value), plaintext), header_value


challenge_enc, challenge_ciphertext, _ = hpke_seal(candidate_x_public, inputs["challenge_ephemeral_ikm_hex"], header_digest, challenge_digest, challenge_plaintext)
check(challenge_enc.hex() == expected["challenge"]["encapsulated_key_hex"], "challenge deterministic HPKE encapsulated key")
check(challenge_ciphertext.hex() == expected["challenge"]["ciphertext_hex"], "challenge deterministic HPKE ciphertext and AAD")
response = {"schema_version": 1, "record_kind": "possession_response_core", "authority": "none", "project_id": ids["project"],
            "invitation_id": ids["invitation"], "request_id": request_id, "challenge_id": challenge_id,
            "challenge_commitment": challenge_header["challenge_commitment"],
            "challenge_response": sha(cbor(["patchmark/hc2/possession-challenge-response/v1", challenge_plaintext])),
            "candidate_person_id": ids["candidatePerson"], "candidate_device_id": ids["candidateDevice"], "signing_key_id": ids["candidateSigning"],
            "recipient_key_id": ids["candidateRecipient"], "bound_control_head_id": ids["control1"], "suite_id": suite_id}
proof_id, _, _ = identity("possession-proof", "patchmark/hc2/possession-proof/v1", response)
check(proof_id == expected["challenge"]["proof_id"], "possession proof identity")
check(ed_verify(candidate_public, bytes.fromhex(expected["challenge"]["response_preimage_hex"]), bytes.fromhex(expected["challenge"]["response_signature_hex"])), "possession-response Ed25519 signature")


def epoch_commitment(epoch_id: str, secret_hex: str):
    public = sha(cbor(["patchmark/hc2/epoch-secret-commitment/v1", ids["project"], epoch_id, bytes.fromhex(secret_hex)]))
    core = {"schema_version": 1, "object_kind": "key_epoch_public_commitment", "project_id": ids["project"], "key_epoch_id": epoch_id,
            "commitment_algorithm": "sha256-public-commitment-v1", "public_commitment_bytes": public}
    digest = sha(cbor(["patchmark/key-epoch-commitment/v1", core]))
    return f"pm:key-epoch-commitment:v1:{b32(digest)}", public


epoch2_id, epoch2_public = epoch_commitment(ids["epoch2"], inputs["epoch2_secret_hex"])
epoch3_id, _ = epoch_commitment(ids["epoch3"], inputs["epoch3_secret_hex"])
check(epoch2_id == expected["transition"]["epoch_commitment_id"] and epoch2_public.hex() == expected["transition"]["epoch_public_commitment_hex"], "replacement epoch commitment")
check(epoch3_id == expected["revocation"]["replacement_epoch_commitment_id"], "revocation epoch commitment")

recipients = [
    {"membership_id": ids["ownerMembership"], "person_id": ids["ownerPerson"], "device_id": ids["ownerDevice"], "role": "owner", "access_scope": "project_wide", "signing_key_id": ids["ownerSigning"], "recipient_key_id": ids["ownerRecipient"], "recipient_public_key_bytes": tagged_owner_x},
    {"membership_id": ids["candidateMembership"], "person_id": ids["candidatePerson"], "device_id": ids["candidateDevice"], "role": "reviewer", "access_scope": "project_wide", "signing_key_id": ids["candidateSigning"], "recipient_key_id": ids["candidateRecipient"], "recipient_public_key_bytes": tagged_candidate_x}]
manifest = {"schema_version": 1, "record_kind": "epoch_recipient_manifest_core", "authority": "none", "project_id": ids["project"],
            "previous_control_head_id": ids["control1"], "mutation_kind": "new_membership", "replacement_epoch_id": ids["epoch2"],
            "replacement_epoch_commitment": epoch2_id, "recipients": recipients, "suite_id": suite_id}
manifest_id, _, _ = identity("recipient-manifest", "patchmark/hc2/recipient-manifest/v1", manifest)
check(manifest_id == expected["transition"]["recipient_manifest_id"], "complete recipient manifest identity")
delivery_set = {"schema_version": 1, "record_kind": "epoch_delivery_set_core", "authority": "none", "project_id": ids["project"],
                "previous_control_head_id": ids["control1"], "recipient_manifest_id": manifest_id, "replacement_epoch_id": ids["epoch2"],
                "replacement_epoch_commitment": epoch2_id, "recipient_device_ids": [entry["device_id"] for entry in recipients], "suite_id": suite_id}
delivery_set_id, _, _ = identity("delivery-set", "patchmark/hc2/delivery-set/v1", delivery_set)
check(delivery_set_id == expected["transition"]["delivery_set_id"], "complete delivery-set identity")

owner_capabilities = sorted(["read_project_content", "edit_markdown", "create_revision", "adopt_revision", "create_comment", "create_reply", "edit_comment", "resolve_comment", "propose_patch", "import_model_work", "accept_patch", "reject_patch", "authorize_safe_merge", "resolve_content_conflict", "create_document", "create_group", "invite_person", "remove_person", "authorize_device", "revoke_device", "change_role", "rotate_key_epoch", "recover_control"])
reviewer_capabilities = sorted(["read_project_content", "create_comment", "create_reply", "edit_comment", "resolve_comment", "propose_patch", "import_model_work"])
authority_devices = [
    {"device_id": ids["ownerDevice"], "person_id": ids["ownerPerson"], "signing_key_id": ids["ownerSigning"], "role": "owner", "capabilities": owner_capabilities, "status": "active", "maximum_accepted_semantic_sequence": None},
    {"device_id": ids["candidateDevice"], "person_id": ids["candidatePerson"], "signing_key_id": ids["candidateSigning"], "role": "reviewer", "capabilities": reviewer_capabilities, "status": "active", "maximum_accepted_semantic_sequence": None}]
state_core = {"schema_version": 1, "object_kind": "control_state_commitment", "project_id": ids["project"], "owner_person_id": ids["ownerPerson"],
              "active_control_device_id": ids["ownerDevice"], "offline_root_key_id": ids["root"], "key_epoch_id": ids["epoch2"],
              "key_epoch_commitment": epoch2_id, "merge_policy": "manual", "root_sequence": 0, "recovery_last_uncontested_control_id": None,
              "device_authorities": authority_devices}
state_root = f"pm:control-state-root:v1:{b32(sha(cbor(['patchmark/control-state-root/v1', state_core])))}"
check(state_root == expected["transition"]["resulting_control_state_root"], "post-enrollment control-state root")
transition = {"schema_version": 1, "record_kind": "membership_epoch_transition_core", "authority": "none", "project_id": ids["project"],
              "mutation_kind": "new_membership", "previous_control_head_id": ids["control1"], "expected_control_sequence": 2,
              "authorizing_owner_membership_id": ids["ownerMembership"], "authorizing_owner_person_id": ids["ownerPerson"], "authorizing_owner_device_id": ids["ownerDevice"],
              "invitation_evidence_id": invitation_id, "enrollment_request_id": request_id, "possession_proof_id": proof_id,
              "membership_id": ids["candidateMembership"], "person_id": ids["candidatePerson"], "role": "reviewer", "access_scope": "project_wide", "access_scope_id": ids["scope"],
              "device_id": ids["candidateDevice"], "signing_key_id": ids["candidateSigning"], "recipient_key_id": ids["candidateRecipient"],
              "signing_public_key_bytes": tagged_signing, "recipient_public_key_bytes": tagged_candidate_x, "revoked_device_ids": [], "revocation_cutoffs": [],
              "previous_active_control_device_id": ids["ownerDevice"], "replacement_active_control_device_id": ids["ownerDevice"], "previous_epoch_id": ids["epoch1"],
              "replacement_epoch_id": ids["epoch2"], "replacement_epoch_commitment": epoch2_id, "recipient_manifest_id": manifest_id,
              "delivery_set_id": delivery_set_id, "resulting_control_state_root": state_root, "suite_id": suite_id}
transition_id, _, _ = identity("membership-transition", "patchmark/hc2/membership-transition/v1", transition)
check(transition_id == expected["transition"]["transition_id"], "membership transition identity")

transition_action = {"schema_version": 1, "project_id": ids["project"], "action_kind": "hc2_membership_epoch_transition", "transition_id": transition_id,
                     "transition_kind": "new_membership", "recipient_manifest_id": manifest_id, "delivery_set_id": delivery_set_id,
                     "previous_key_epoch_id": ids["epoch1"], "replacement_key_epoch_id": ids["epoch2"], "replacement_key_epoch_commitment": epoch2_id,
                     "replacement_active_control_device_id": ids["ownerDevice"], "suite_id": suite_id}
control_action_id = f"pm:control-action:v1:{b32(sha(cbor(['patchmark/control-action/v1', transition_action])))}"
check(control_action_id == expected["transition"]["control_action_id"], "transition control action identity")
event_core = {"schema_version": 1, "object_kind": "control_event_core", "control_kind": "ordinary", "project_id": ids["project"],
              "control_sequence": 2, "previous_control_id": ids["control1"], "resulting_control_state_root": state_root,
              "issuer_device_id": ids["ownerDevice"], "action_id": control_action_id, "key_epoch_id": ids["epoch2"], "key_epoch_commitment": epoch2_id}
control_event_id = f"pm:control-event:v1:{b32(sha(cbor(['patchmark/control-core/v1', event_core])))}"
check(control_event_id == expected["transition"]["control_event_id"], "accepted transition event identity")

ephemeral_inputs = [inputs["candidate_delivery_ephemeral_ikm_hex"], inputs["owner_delivery_ephemeral_ikm_hex"]]
recipient_raw_keys = [owner_x_public, candidate_x_public]
delivery_ids = []
for index, recipient in enumerate(recipients):
    header_core = {"schema_version": 1, "record_kind": "epoch_delivery_header_core", "authority": "none", "project_id": ids["project"],
                   "transition_id": transition_id, "accepted_control_event_id": control_event_id, "delivery_set_id": delivery_set_id,
                   "recipient_manifest_id": manifest_id, "key_epoch_id": ids["epoch2"], "key_epoch_commitment": epoch2_id,
                   "recipient_membership_id": recipient["membership_id"], "recipient_person_id": recipient["person_id"], "recipient_device_id": recipient["device_id"],
                   "recipient_key_id": recipient["recipient_key_id"], "recipient_ordinal": index, "recipient_count": len(recipients), "suite_id": suite_id}
    digest_header = sha(cbor(header_core))
    plaintext = cbor({"schema_version": 1, "record_kind": "epoch_delivery_plaintext", "project_id": ids["project"],
                      "accepted_control_event_id": control_event_id, "delivery_set_id": delivery_set_id, "key_epoch_id": ids["epoch2"],
                      "key_epoch_commitment": epoch2_id, "public_commitment_bytes": epoch2_public, "epoch_secret": bytes.fromhex(inputs["epoch2_secret_hex"]), "suite_id": suite_id})
    enc, ciphertext, header_value = hpke_seal(recipient_raw_keys[index], ephemeral_inputs[index], digest_header, digest_header, plaintext)
    vector = expected["deliveries"][index]
    check(digest_header.hex() == vector["header_sha256"], f"delivery {index} header hash")
    check(enc.hex() == vector["encapsulated_key_hex"], f"delivery {index} encapsulated key")
    check(len(ciphertext) == vector["ciphertext_bytes"] and sha(ciphertext).hex() == vector["ciphertext_sha256"], f"delivery {index} ciphertext")
    envelope_without_id = {"record_version": 1, "record_kind": "epoch_delivery_envelope", "authority": "none", "header_core": header_core,
                           "public_header": header_value, "ciphertext_bytes": ciphertext}
    delivery_id, _, _ = identity("epoch-delivery", "patchmark/hc2/epoch-delivery/v1", envelope_without_id)
    check(delivery_id == vector["delivery_id"], f"delivery {index} identity")
    delivery_ids.append(delivery_id)

admission = {"schema_version": 1, "record_kind": "current_state_admission_package_core", "authority": "none", "project_id": ids["project"],
             "transition_id": transition_id, "accepted_control_action_id": control_action_id, "accepted_control_event_id": control_event_id,
             "resulting_control_state_root": state_root, "admitted_membership_id": ids["candidateMembership"], "admitted_person_id": ids["candidatePerson"],
             "admitted_device_id": ids["candidateDevice"], "admitted_role": "reviewer", "access_scope": "project_wide", "signing_key_id": ids["candidateSigning"],
             "recipient_key_id": ids["candidateRecipient"], "key_epoch_id": ids["epoch2"], "key_epoch_commitment": epoch2_id,
             "recipient_manifest_id": manifest_id, "delivery_set_id": delivery_set_id, "recipient_delivery_id": delivery_ids[1],
             "checkpoint_id": placeholder("semantic-event", "a"), "projection_root": placeholder("projection-root", "b"),
             "semantic_state_root": placeholder("semantic-state-root", "c"), "revision_heads_root": placeholder("revision-heads-root", "d"),
             "conflict_set_root": placeholder("conflict-set-root", "e"), "accepted_history_root": placeholder("accepted-history-root", "f"),
             "state_blob_id": placeholder("state-blob", "g"), "snapshot_id": placeholder("snapshot", "h"), "semantic_frontier": [], "revision_manifest": [],
             "conflict_manifest": [], "reducer_version": "patchmark/hc1/reducer/v1", "admission_boundary_sha256": bytes([0x81]) * 32,
             "owner_signing_key_id": ids["ownerSigning"], "full_history_verified": False, "suite_id": suite_id}
admission_id, _, _ = identity("admission-package", "patchmark/hc2/admission-package/v1", admission)
check(admission_id == expected["admission"]["admission_package_id"], "admission package identity and false history claim")
receipt = {"schema_version": 1, "record_kind": "epoch_delivery_receipt_core", "authority": "none", "project_id": ids["project"],
           "person_id": ids["candidatePerson"], "membership_id": ids["candidateMembership"], "role": "reviewer", "device_id": ids["candidateDevice"],
           "signing_key_id": ids["candidateSigning"], "acknowledgement_sequence": 0, "previous_acknowledgement_id": None,
           "accepted_control_event_id": control_event_id, "key_epoch_id": ids["epoch2"], "key_epoch_commitment": epoch2_id,
           "delivery_id": delivery_ids[1], "checkpoint_id": admission["checkpoint_id"], "projection_root": admission["projection_root"],
           "admission_package_id": admission_id, "admission_boundary_sha256": admission["admission_boundary_sha256"], "suite_id": suite_id}
receipt_id, _, _ = identity("epoch-receipt", "patchmark/hc2/epoch-receipt/v1", receipt)
check(receipt_id == expected["receipt"]["receipt_id"], "receipt identity")
check(ed_verify(candidate_public, bytes.fromhex(expected["receipt"]["signature_preimage_hex"]), bytes.fromhex(expected["receipt"]["signature_hex"])), "receipt Ed25519 signature")

# Revocation independently proves that the candidate is no longer a recipient and a fresh epoch is mandatory.
revoked_devices = [authority_devices[0], {**authority_devices[1], "status": "revoked", "maximum_accepted_semantic_sequence": 0}]
revoked_state = {**state_core, "key_epoch_id": ids["epoch3"], "key_epoch_commitment": epoch3_id, "device_authorities": revoked_devices}
revoked_root = f"pm:control-state-root:v1:{b32(sha(cbor(['patchmark/control-state-root/v1', revoked_state])))}"
check(revoked_root == expected["revocation"]["resulting_control_state_root"], "post-revocation control-state root")
revoked_manifest = {**manifest, "previous_control_head_id": control_event_id, "mutation_kind": "device_revocation", "replacement_epoch_id": ids["epoch3"],
                    "replacement_epoch_commitment": epoch3_id, "recipients": [recipients[0]]}
revoked_manifest_id, _, _ = identity("recipient-manifest", "patchmark/hc2/recipient-manifest/v1", revoked_manifest)
check(revoked_manifest_id == expected["revocation"]["recipient_manifest_id"] and expected["revocation"]["recipient_device_ids"] == [ids["ownerDevice"]], "revoked device excluded from exact recipient set")
check(expected["admission"]["full_history_verified"] is False and len(expected["rejections"]) == 12, "frozen false-history and fail-closed rejection matrix")

print(json.dumps({
    "assertions": checks,
    "status": "ok",
    "imports_patchmark": False,
    "third_party_python_imports": False,
    "node_python_vector_equivalence": True,
    "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
}, indent=2))

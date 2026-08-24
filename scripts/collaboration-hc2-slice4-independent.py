#!/usr/bin/env python3
"""Independent HC-2 Slice 4 verifier: stdlib only and no Patchmark imports."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import struct
from pathlib import Path

FIXTURE = Path(__file__).with_name("fixtures") / "collaboration-hc2-slice4-v1.json"
data = json.loads(FIXTURE.read_text(encoding="utf-8"))
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        raise AssertionError(message)


def hx(value: str) -> bytes:
    return bytes.fromhex(value)


def sha(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()


def b32(value: bytes) -> str:
    return base64.b32encode(value).decode("ascii").rstrip("=").lower()


# Minimal deterministic CBOR for the closed fixture model.
def cbor_head(major: int, value: int) -> bytes:
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
        return cbor_head(0, value)
    if isinstance(value, bytes):
        return cbor_head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return cbor_head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return cbor_head(4, len(value)) + b"".join(cbor(child) for child in value)
    if isinstance(value, dict):
        entries = [(cbor(key), cbor(child)) for key, child in value.items()]
        entries.sort(key=lambda item: (len(item[0]), item[0]))
        return cbor_head(5, len(entries)) + b"".join(key + child for key, child in entries)
    raise TypeError(f"unsupported fixture CBOR value: {type(value)!r}")


def read_head(raw: bytes, offset: int):
    initial = raw[offset]
    major, additional = initial >> 5, initial & 31
    offset += 1
    if additional < 24:
        return major, additional, offset
    widths = {24: 1, 25: 2, 26: 4, 27: 8}
    width = widths.get(additional)
    if width is None or offset + width > len(raw):
        raise ValueError("indefinite, reserved, or truncated CBOR")
    value = int.from_bytes(raw[offset:offset + width], "big")
    if value < (24 if width == 1 else 1 << (8 * (width - 1))):
        raise ValueError("non-minimal CBOR integer")
    return major, value, offset + width


def decode_one(raw: bytes, offset: int = 0):
    initial = raw[offset]
    if initial == 0xF4:
        return False, offset + 1
    if initial == 0xF5:
        return True, offset + 1
    if initial == 0xF6:
        return None, offset + 1
    major, value, offset = read_head(raw, offset)
    if major == 0:
        return value, offset
    if major in (2, 3):
        end = offset + value
        if end > len(raw):
            raise ValueError("truncated CBOR string")
        child = raw[offset:end]
        return (child if major == 2 else child.decode("utf-8")), end
    if major == 4:
        result = []
        for _ in range(value):
            child, offset = decode_one(raw, offset)
            result.append(child)
        return result, offset
    if major == 5:
        result = {}
        encoded_keys = []
        for _ in range(value):
            key_start = offset
            key, offset = decode_one(raw, offset)
            encoded_keys.append(raw[key_start:offset])
            child, offset = decode_one(raw, offset)
            if key in result:
                raise ValueError("duplicate CBOR key")
            result[key] = child
        if encoded_keys != sorted(encoded_keys, key=lambda key: (len(key), key)):
            raise ValueError("noncanonical CBOR map order")
        return result, offset
    raise ValueError("unsupported CBOR major type")


def canonical_decode(raw: bytes):
    value, end = decode_one(raw)
    if end != len(raw) or cbor(value) != raw:
        raise ValueError("CBOR was not exact and canonical")
    return value


# Pure-Python Ed25519 verification (RFC 8032 formulas).
Q = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, Q - 2, Q)) % Q
I = pow(2, (Q - 1) // 4, Q)


def xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(D * y * y + 1, Q - 2, Q) % Q
    x = pow(xx, (Q + 3) // 8, Q)
    if (x * x - xx) % Q:
        x = x * I % Q
    return x if x % 2 == 0 else Q - x


BY = 4 * pow(5, Q - 2, Q) % Q
B = (xrecover(BY), BY)


def ed_add(p, q):
    x1, y1 = p
    x2, y2 = q
    denominator_x = pow(1 + D * x1 * x2 * y1 * y2, Q - 2, Q)
    denominator_y = pow(1 - D * x1 * x2 * y1 * y2, Q - 2, Q)
    return ((x1 * y2 + x2 * y1) * denominator_x % Q,
            (y1 * y2 + x1 * x2) * denominator_y % Q)


def ed_mul(point, scalar: int):
    result = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result = ed_add(result, addend)
        addend = ed_add(addend, addend)
        scalar >>= 1
    return result


def ed_encode(point) -> bytes:
    x, y = point
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def ed_decode(encoded: bytes):
    if len(encoded) != 32:
        raise ValueError("bad Ed25519 point length")
    integer = int.from_bytes(encoded, "little")
    y, sign = integer & ((1 << 255) - 1), integer >> 255
    if y >= Q:
        raise ValueError("noncanonical Ed25519 point")
    x = xrecover(y)
    if x & 1 != sign:
        x = Q - x
    point = (x, y)
    if ed_encode(point) != encoded:
        raise ValueError("noncanonical Ed25519 encoding")
    return point


def ed_public_from_seed(seed: bytes) -> bytes:
    digest = hashlib.sha512(seed).digest()
    scalar = int.from_bytes(digest[:32], "little")
    scalar &= (1 << 254) - 8
    scalar |= 1 << 254
    return ed_encode(ed_mul(B, scalar))


def ed_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(signature) != 64:
        return False
    try:
        r = ed_decode(signature[:32])
        a = ed_decode(public)
    except ValueError:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % L
    return ed_encode(ed_mul(B, s)) == ed_encode(ed_add(r, ed_mul(a, h)))


# Pure-Python AES-256 and GCM known-answer verification.
def gf_mul8(a: int, b: int) -> int:
    result = 0
    for _ in range(8):
        if b & 1:
            result ^= a
        a = ((a << 1) ^ (0x11B if a & 0x80 else 0)) & 0xFF
        b >>= 1
    return result


def aes_sbox(value: int) -> int:
    inverse = 0 if value == 0 else pow_gf(value, 254)
    result = inverse
    for shift in range(1, 5):
        result ^= ((inverse << shift) | (inverse >> (8 - shift))) & 0xFF
    return result ^ 0x63


def pow_gf(value: int, exponent: int) -> int:
    result = 1
    while exponent:
        if exponent & 1:
            result = gf_mul8(result, value)
        value = gf_mul8(value, value)
        exponent >>= 1
    return result


SBOX = [aes_sbox(value) for value in range(256)]


def aes_words(key: bytes):
    words = [list(key[index:index + 4]) for index in range(0, len(key), 4)]
    rcon = 1
    while len(words) < 60:
        temp = words[-1][:]
        if len(words) % 8 == 0:
            temp = [SBOX[x] for x in temp[1:] + temp[:1]]
            temp[0] ^= rcon
            rcon = gf_mul8(rcon, 2)
        elif len(words) % 8 == 4:
            temp = [SBOX[x] for x in temp]
        words.append([a ^ b for a, b in zip(words[-8], temp)])
    return words


def aes_encrypt_block(key: bytes, block: bytes) -> bytes:
    words = aes_words(key)
    state = list(block)

    def add_round(round_number):
        for column in range(4):
            for row in range(4):
                state[4 * column + row] ^= words[4 * round_number + column][row]

    add_round(0)
    for round_number in range(1, 15):
        state[:] = [SBOX[x] for x in state]
        state[:] = [state[4 * ((column + row) % 4) + row] for column in range(4) for row in range(4)]
        if round_number != 14:
            for column in range(4):
                a = state[4 * column:4 * column + 4]
                state[4 * column:4 * column + 4] = [
                    gf_mul8(a[0], 2) ^ gf_mul8(a[1], 3) ^ a[2] ^ a[3],
                    a[0] ^ gf_mul8(a[1], 2) ^ gf_mul8(a[2], 3) ^ a[3],
                    a[0] ^ a[1] ^ gf_mul8(a[2], 2) ^ gf_mul8(a[3], 3),
                    gf_mul8(a[0], 3) ^ a[1] ^ a[2] ^ gf_mul8(a[3], 2),
                ]
        add_round(round_number)
    return bytes(state)


def gf_mul128(x: int, y: int) -> int:
    result = 0
    value = y
    for bit in range(128):
        if x & (1 << (127 - bit)):
            result ^= value
        value = (value >> 1) ^ (0xE1000000000000000000000000000000 if value & 1 else 0)
    return result


def ghash(key_hash: bytes, payload: bytes) -> bytes:
    state = 0
    h_value = int.from_bytes(key_hash, "big")
    for offset in range(0, len(payload), 16):
        block = payload[offset:offset + 16].ljust(16, b"\0")
        state = gf_mul128(state ^ int.from_bytes(block, "big"), h_value)
    return state.to_bytes(16, "big")


def aes_gcm_encrypt(key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> bytes:
    if len(nonce) != 12:
        raise ValueError("independent verifier supports the frozen 96-bit nonce only")
    j0 = nonce + b"\0\0\0\1"
    ciphertext = bytearray()
    counter = 2
    for offset in range(0, len(plaintext), 16):
        stream = aes_encrypt_block(key, nonce + counter.to_bytes(4, "big"))
        chunk = plaintext[offset:offset + 16]
        ciphertext.extend(a ^ b for a, b in zip(chunk, stream))
        counter += 1
    encoded = aad + b"\0" * ((-len(aad)) % 16) + bytes(ciphertext) + b"\0" * ((-len(ciphertext)) % 16)
    encoded += struct.pack(">QQ", len(aad) * 8, len(ciphertext) * 8)
    tag = bytes(a ^ b for a, b in zip(aes_encrypt_block(key, j0), ghash(aes_encrypt_block(key, b"\0" * 16), encoded)))
    return bytes(ciphertext) + tag


# Pure-Python XChaCha20-Poly1305 recovery binding verification.
def rotl32(value: int, count: int) -> int:
    return ((value << count) | (value >> (32 - count))) & 0xFFFFFFFF


def quarter(state, a, b, c, d):
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF; state[d] ^= state[a]; state[d] = rotl32(state[d], 16)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF; state[b] ^= state[c]; state[b] = rotl32(state[b], 12)
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF; state[d] ^= state[a]; state[d] = rotl32(state[d], 8)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF; state[b] ^= state[c]; state[b] = rotl32(state[b], 7)


def chacha_rounds(state):
    working = state[:]
    for _ in range(10):
        quarter(working, 0, 4, 8, 12); quarter(working, 1, 5, 9, 13); quarter(working, 2, 6, 10, 14); quarter(working, 3, 7, 11, 15)
        quarter(working, 0, 5, 10, 15); quarter(working, 1, 6, 11, 12); quarter(working, 2, 7, 8, 13); quarter(working, 3, 4, 9, 14)
    return working


def hchacha(key: bytes, nonce16: bytes) -> bytes:
    constants = b"expand 32-byte k"
    state = list(struct.unpack("<4I", constants) + struct.unpack("<8I", key) + struct.unpack("<4I", nonce16))
    work = chacha_rounds(state)
    return struct.pack("<8I", *(work[:4] + work[12:16]))


def chacha_block(key: bytes, counter: int, nonce12: bytes) -> bytes:
    constants = b"expand 32-byte k"
    state = list(struct.unpack("<4I", constants) + struct.unpack("<8I", key) + (counter,) + struct.unpack("<3I", nonce12))
    work = chacha_rounds(state)
    return struct.pack("<16I", *[((work[index] + state[index]) & 0xFFFFFFFF) for index in range(16)])


def xchacha_open(key: bytes, nonce24: bytes, aad: bytes, sealed: bytes) -> bytes:
    subkey = hchacha(key, nonce24[:16])
    nonce12 = b"\0\0\0\0" + nonce24[16:]
    ciphertext, tag = sealed[:-16], sealed[-16:]
    poly_key = chacha_block(subkey, 0, nonce12)[:32]
    mac_data = aad + b"\0" * ((-len(aad)) % 16) + ciphertext + b"\0" * ((-len(ciphertext)) % 16)
    mac_data += struct.pack("<QQ", len(aad), len(ciphertext))
    r = int.from_bytes(poly_key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(poly_key[16:], "little")
    accumulator = 0
    modulus = (1 << 130) - 5
    for offset in range(0, len(mac_data), 16):
        block = mac_data[offset:offset + 16]
        accumulator = (accumulator + int.from_bytes(block + b"\1", "little")) * r % modulus
    expected_tag = ((accumulator + s) % (1 << 128)).to_bytes(16, "little")
    if not hmac.compare_digest(expected_tag, tag):
        raise ValueError("XChaCha20-Poly1305 authentication failed")
    plaintext = bytearray()
    for offset in range(0, len(ciphertext), 64):
        stream = chacha_block(subkey, 1 + offset // 64, nonce12)
        chunk = ciphertext[offset:offset + 64]
        plaintext.extend(a ^ b for a, b in zip(chunk, stream))
    return bytes(plaintext)


# Canonical and identity evidence.
kit = data["recovery_kit"]
container = hx(kit["container_canonical_hex"])
aad = hx(kit["public_header_aad_hex"])
for name, raw in (("container", container), ("header AAD", aad)):
    canonical_decode(raw)
    check(cbor(canonical_decode(raw)) == raw, f"{name} canonical bytes")
check(len(container) == kit["container_bytes"], "container length")
check(sha(container).hex() == kit["container_sha256"], "container SHA-256")

# Decrypt at runtime; the fixture stores only length/hash commitments, never payload plaintext.
opened = xchacha_open(
    hx(kit["derived_key_hex"]), hx(kit["nonce_hex"]), aad,
    hx(kit["ciphertext_and_tag_hex"])
)
check(len(opened) == kit["payload_bytes"], "recovery payload committed length")
check(sha(opened).hex() == kit["payload_sha256"], "recovery payload committed SHA-256")
payload_value = canonical_decode(opened)
check(payload_value[0] == "patchmark/hc2/recovery-kit-payload/v1", "recovery payload domain")
payload_record = payload_value[1]
check(payload_record["project_id"] == data["identities"]["project_id"], "recovery payload project binding")
check(payload_record["root_key_id"] == data["identities"]["root_key_id"], "recovery payload root binding")

root = data["root_ed25519"]
seed = payload_record["root_seed"]
public = hx(root["raw_public_key_hex"])
check(ed_public_from_seed(seed) == public, "RFC Ed25519 public derivation")
tagged = canonical_decode(hx(root["tagged_public_key_hex"]))
check(tagged[0] == "patchmark/hc2/public-key/v1" and tagged[1] == "ed25519", "tagged root algorithm")
check(tagged[2] == data["identities"]["root_key_id"] and tagged[3] == public, "tagged root identity and bytes")

for section_name in ("initial_foundation", "root_recovery"):
    section = data[section_name]
    preimage = hx(section["root_signature_preimage_hex"])
    decoded = canonical_decode(preimage)
    check(decoded[0] == "patchmark/signature/control-event/v1", f"{section_name} signature domain")
    check(decoded[1] == data["identities"]["project_id"], f"{section_name} signature project")
    check(decoded[2].hex() == section["control_core_sha256"], f"{section_name} signature digest binding")
    check(ed_verify(public, preimage, hx(section["root_signature_hex"])), f"{section_name} Ed25519 signature")
    check(section["control_event_id"].rsplit(":", 1)[1] == b32(hx(section["control_core_sha256"])), f"{section_name} Base32 identity")
check(data["root_recovery"]["action_id"].rsplit(":", 1)[1] == b32(hx(data["root_recovery"]["action_canonical_sha256"])), "root-recovery action Base32 identity")

# Epoch commitment and AES-GCM evidence.
epoch = data["epoch_wrap"]
ids = data["identities"]
commitment_public = sha(cbor([
    "patchmark/hc2/epoch-secret-commitment/v1",
    ids["project_id"], ids["initial_epoch_id"], hx(epoch["epoch_secret_hex"])
]))
check(commitment_public.hex() == epoch["public_commitment_bytes_hex"], "epoch public commitment")
commitment_core = {
    "schema_version": 1,
    "object_kind": "key_epoch_public_commitment",
    "project_id": ids["project_id"],
    "key_epoch_id": ids["initial_epoch_id"],
    "commitment_algorithm": "sha256-public-commitment-v1",
    "public_commitment_bytes": commitment_public,
}
commitment_digest = sha(cbor(["patchmark/key-epoch-commitment/v1", commitment_core]))
check(epoch["key_epoch_commitment_id"].rsplit(":", 1)[1] == b32(commitment_digest), "epoch Base32 commitment identity")
aes_result = aes_gcm_encrypt(hx(epoch["aes_key_hex"]), hx(epoch["nonce_hex"]), hx(epoch["aad_hex"]), hx(epoch["epoch_secret_hex"]))
check(aes_result.hex() == epoch["ciphertext_and_tag_hex"], "AES-256-GCM epoch wrapping")

# Recovery container binding. Argon2id is intentionally a reported system boundary.
container_value = canonical_decode(container)
check(container_value[1]["encrypted_payload"] == hx(kit["ciphertext_and_tag_hex"]), "container ciphertext binding")
check(container_value[1]["public_header"]["project_id"] == ids["project_id"], "container project binding")
check(container_value[1]["public_header"]["root_key_id"] == ids["root_key_id"], "container root binding")
check(ids["new_device_id"] != ids["old_device_id"], "frozen recovery uses a new device identity")
check(data["root_recovery"]["late_old_device_result"] == "superseded_control_branch", "late old device is superseded")
check(len(data["rejections"]) == 14, "rejection matrix count")

print(json.dumps({
    "assertions": checks,
    "status": "ok",
    "imports_patchmark": False,
    "third_party_python_imports": False,
    "argon2id_boundary": "Python stdlib and the installed OpenSSL CLI expose no Argon2id primitive; the frozen derived key is consumed only to independently verify XChaCha20-Poly1305 and its exact recovery binding.",
}, indent=2))

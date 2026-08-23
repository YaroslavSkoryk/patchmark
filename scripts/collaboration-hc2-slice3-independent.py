#!/usr/bin/env python3
"""Independent HC-2 Slice 3 vector verifier: stdlib + system OpenSSL only."""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "collaboration-hc2-slice3-v1.json"
data = json.loads(FIXTURE.read_text(encoding="utf-8"))
assertions = 0


def check(condition: bool, message: str) -> None:
    global assertions
    assertions += 1
    if not condition:
        raise AssertionError(message)


def hx(value: str) -> bytes:
    return bytes.fromhex(value)


# RFC 7748 X25519, implemented here rather than importing Patchmark or a Python package.
P25519 = 2**255 - 19
A24 = 121665


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
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = bit
        a = (x2 + z2) % P25519
        aa = a * a % P25519
        b = (x2 - z2) % P25519
        bb = b * b % P25519
        e = (aa - bb) % P25519
        c = (x3 + z3) % P25519
        d = (x3 - z3) % P25519
        da = d * a % P25519
        cb = c * b % P25519
        x3 = (da + cb) ** 2 % P25519
        z3 = x1 * ((da - cb) ** 2) % P25519
        x2 = aa * bb % P25519
        z2 = e * (aa + A24 * e) % P25519
    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    return (x2 * pow(z2, P25519 - 2, P25519) % P25519).to_bytes(32, "little")


xvector = data["x25519"]
base = bytes([9]) + bytes(31)
check(x25519(hx(xvector["alice_private_hex"]), base).hex() == xvector["alice_public_hex"], "RFC 7748 Alice public key")
check(x25519(hx(xvector["bob_private_hex"]), base).hex() == xvector["bob_public_hex"], "RFC 7748 Bob public key")
check(x25519(hx(xvector["alice_private_hex"]), hx(xvector["bob_public_hex"])).hex() == xvector["shared_secret_hex"], "RFC 7748 Alice shared secret")
check(x25519(hx(xvector["bob_private_hex"]), hx(xvector["alice_public_hex"])).hex() == xvector["shared_secret_hex"], "RFC 7748 Bob shared secret")
check(x25519(hx(xvector["alice_private_hex"]), bytes(32)) == bytes(32), "low-order X25519 input produces the rejectable all-zero secret")


# RFC 8032 Ed25519 verification, independently implemented from the RFC formulas.
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
    if (x * x - xx) % Q or (x == 0 and sign):
        raise ValueError("invalid Ed25519 point")
    if (x & 1) != sign:
        x = Q - x
    return x


def decode_point(encoded: bytes) -> tuple[int, int]:
    value = int.from_bytes(encoded, "little")
    y = value & ((1 << 255) - 1)
    if y >= Q:
        raise ValueError("noncanonical Ed25519 point")
    return recover_x(y, value >> 255), y


def point_add(p: tuple[int, int], q: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = p
    x2, y2 = q
    product = D * x1 * x2 * y1 * y2 % Q
    return (
        (x1 * y2 + x2 * y1) * inv(1 + product) % Q,
        (y1 * y2 + x1 * x2) * inv(1 - product) % Q,
    )


def scalar_mult(point: tuple[int, int], scalar: int) -> tuple[int, int]:
    result = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        scalar >>= 1
    return result


def ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    try:
        if len(public) != 32 or len(signature) != 64:
            return False
        r_encoded, s_encoded = signature[:32], signature[32:]
        scalar = int.from_bytes(s_encoded, "little")
        if scalar >= L:
            return False
        public_point = decode_point(public)
        r_point = decode_point(r_encoded)
        base_y = 4 * inv(5) % Q
        base = recover_x(base_y, 0), base_y
        challenge = int.from_bytes(hashlib.sha512(r_encoded + public + message).digest(), "little") % L
        return scalar_mult(base, scalar) == point_add(r_point, scalar_mult(public_point, challenge))
    except ValueError:
        return False


edvector = data["ed25519"]
ed_signature = hx(edvector["signature_hex"])
check(ed25519_verify(hx(edvector["public_key_hex"]), hx(edvector["message_hex"]), ed_signature), "RFC 8032 signature")
tampered = bytes([ed_signature[0] ^ 1]) + ed_signature[1:]
check(not ed25519_verify(hx(edvector["public_key_hex"]), b"", tampered), "tampered Ed25519 signature")
check(not ed25519_verify(bytes(32), b"", ed_signature), "wrong Ed25519 key")
check(not ed25519_verify(hx(edvector["public_key_hex"]), b"", ed_signature[:-1]), "truncated Ed25519 signature")


# XChaCha20-Poly1305, independently implemented from RFC 8439 + XChaCha draft.
def rotate(value: int, amount: int) -> int:
    return ((value << amount) | (value >> (32 - amount))) & 0xFFFFFFFF


def quarter(state: list[int], a: int, b: int, c: int, d: int) -> None:
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF
    state[d] = rotate(state[d] ^ state[a], 16)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF
    state[b] = rotate(state[b] ^ state[c], 12)
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF
    state[d] = rotate(state[d] ^ state[a], 8)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF
    state[b] = rotate(state[b] ^ state[c], 7)


def rounds(state: list[int]) -> list[int]:
    working = state[:]
    for _ in range(10):
        quarter(working, 0, 4, 8, 12); quarter(working, 1, 5, 9, 13)
        quarter(working, 2, 6, 10, 14); quarter(working, 3, 7, 11, 15)
        quarter(working, 0, 5, 10, 15); quarter(working, 1, 6, 11, 12)
        quarter(working, 2, 7, 8, 13); quarter(working, 3, 4, 9, 14)
    return working


def words(value: bytes) -> list[int]:
    return [int.from_bytes(value[index:index + 4], "little") for index in range(0, len(value), 4)]


def hchacha(key: bytes, nonce16: bytes) -> bytes:
    state = words(b"expand 32-byte k") + words(key) + words(nonce16)
    output = rounds(state)
    return b"".join(value.to_bytes(4, "little") for value in [output[0], output[1], output[2], output[3], output[12], output[13], output[14], output[15]])


def chacha_block(key: bytes, counter: int, nonce12: bytes) -> bytes:
    initial = words(b"expand 32-byte k") + words(key) + [counter] + words(nonce12)
    output = rounds(initial)
    return b"".join(((output[index] + initial[index]) & 0xFFFFFFFF).to_bytes(4, "little") for index in range(16))


def chacha_xor(key: bytes, nonce12: bytes, counter: int, value: bytes) -> bytes:
    stream = b"".join(chacha_block(key, counter + index, nonce12) for index in range((len(value) + 63) // 64))
    return bytes(left ^ right for left, right in zip(value, stream))


def pad16(value: bytes) -> bytes:
    return value + bytes((-len(value)) % 16)


def poly1305(message: bytes, key: bytes) -> bytes:
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key[16:], "little")
    accumulator = 0
    prime = (1 << 130) - 5
    for index in range(0, len(message), 16):
        block = message[index:index + 16]
        accumulator = (accumulator + int.from_bytes(block + b"\x01", "little")) * r % prime
    return ((accumulator + s) % (1 << 128)).to_bytes(16, "little")


def xchacha_seal(key: bytes, nonce24: bytes, aad: bytes, plaintext: bytes) -> bytes:
    subkey = hchacha(key, nonce24[:16])
    nonce12 = bytes(4) + nonce24[16:]
    ciphertext = chacha_xor(subkey, nonce12, 1, plaintext)
    mac_data = pad16(aad) + pad16(ciphertext) + len(aad).to_bytes(8, "little") + len(ciphertext).to_bytes(8, "little")
    tag = poly1305(mac_data, chacha_block(subkey, 0, nonce12)[:32])
    return ciphertext + tag


xcvector = data["xchacha20_poly1305"]
independent_xc = xchacha_seal(hx(xcvector["key_hex"]), hx(xcvector["nonce_hex"]), hx(xcvector["aad_hex"]), hx(xcvector["plaintext_hex"]))
check(independent_xc.hex() == xcvector["ciphertext_hex"] + xcvector["tag_hex"], "published XChaCha20-Poly1305 vector")
check(len(independent_xc) == len(hx(xcvector["plaintext_hex"])) + 16, "XChaCha tag length")


# OpenSSL is a second, non-Patchmark implementation for the full RFC 9106 vector,
# including secret, associated data, four lanes, and version 19.
avector = data["argon2id"]
command = [
    "openssl", "kdf", "-keylen", str(avector["tag_length"]),
    "-kdfopt", f"hexpass:{avector['password_hex']}",
    "-kdfopt", f"hexsalt:{avector['salt_hex']}",
    "-kdfopt", f"hexsecret:{avector['secret_hex']}",
    "-kdfopt", f"hexad:{avector['associated_data_hex']}",
    "-kdfopt", f"iter:{avector['iterations']}",
    "-kdfopt", f"memcost:{avector['memory_kib']}",
    "-kdfopt", f"lanes:{avector['parallelism']}",
    "-kdfopt", "threads:1", "-kdfopt", "version:19", "ARGON2ID",
]
argon_output = subprocess.run(command, check=True, capture_output=True, text=True).stdout.replace(":", "").strip().lower()
check(argon_output == avector["tag_hex"], "OpenSSL matches RFC 9106 Argon2id vector")


hpke = data["hpke"]
check(hpke["mode"] == 0 and hpke["kem_id"] == 32 and hpke["kdf_id"] == 1 and hpke["aead_id"] == 2, "HPKE exact-suite identifiers")
check(len(hx(hpke["encapsulated_key_hex"])) == 32, "HPKE encapsulated-key length")
check(len(hx(hpke["ciphertext_hex"])) == len(hx(hpke["plaintext_hex"])) + 16, "HPKE AES-GCM tag length")
check(len(hpke["upstream_artifact_sha256"]) == 64 and len(hpke["upstream_commit"]) == 40, "HPKE upstream artifact provenance")
check(data["patchmark_recovery"]["memlimit_bytes"] == 64 * 1024 * 1024, "production recovery memory parameter")
check(data["patchmark_recovery"]["parallelism"] == "provider_managed_not_configurable", "production recovery parallelism claim is truthful")

print(json.dumps({
    "assertions": assertions,
    "patchmark_imports": 0,
    "third_party_python_packages": 0,
    "independent_implementations": ["python-stdlib-rfc-formulas", "system-openssl-argon2id"],
    "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
}, indent=2))

#!/usr/bin/env python3
"""Independent HC-2 transport-v2 fixture verifier; imports no Patchmark code."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import sys

FIXTURE = pathlib.Path(__file__).with_name("fixtures") / "collaboration-hc2-slice6-v2.json"
raw = FIXTURE.read_bytes()
fixture = json.loads(raw)
inputs = fixture["inputs"]
expected = fixture["expected"]
assert fixture["fixture_version"] == 2
assert len(raw) < 2 * 1024 * 1024
assert "18874384" not in raw.decode("utf-8")

ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"


def cbor(value):
    if value is None:
        return b"\xf6"
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if isinstance(value, int):
        assert 0 <= value <= 2**64 - 1
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        assert value == value.encode().decode()  # well-formed, already Python Unicode
        return head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(cbor(child) for child in value)
    if isinstance(value, dict):
        entries = sorted(((cbor(key), cbor(child)) for key, child in value.items()), key=lambda pair: pair[0])
        return head(5, len(entries)) + b"".join(key + child for key, child in entries)
    raise TypeError(type(value))


def head(major, value):
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + value.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + value.to_bytes(8, "big")


def digest_id(kind, version, domain, core):
    digest = hashlib.sha256(cbor([domain, core])).digest()
    suffix = base64.b32encode(digest).decode("ascii").lower().rstrip("=")
    return f"pm:{kind}:v{version}:{suffix}"


def decode_item(data, offset=0):
    start = offset
    first = data[offset]
    offset += 1
    major, additional = first >> 5, first & 31
    if additional < 24:
        argument = additional
    else:
        widths = {24: 1, 25: 2, 26: 4, 27: 8}
        assert additional in widths
        width = widths[additional]
        argument = int.from_bytes(data[offset:offset + width], "big")
        offset += width
        assert (width != 1 or argument >= 24) and (width != 2 or argument > 0xFF) and (width != 4 or argument > 0xFFFF) and (width != 8 or argument > 0xFFFFFFFF)
    if major == 0:
        value = argument
    elif major in (2, 3):
        payload = data[offset:offset + argument]
        assert len(payload) == argument
        offset += argument
        value = payload if major == 2 else payload.decode("utf-8")
    elif major == 4:
        value = []
        for _ in range(argument):
            child, offset = decode_item(data, offset)
            value.append(child)
    elif major == 5:
        value = {}
        encoded_keys = []
        for _ in range(argument):
            key_start = offset
            key, offset = decode_item(data, offset)
            encoded_keys.append(data[key_start:offset])
            child, offset = decode_item(data, offset)
            assert key not in value
            value[key] = child
        assert encoded_keys == sorted(encoded_keys)
    elif major == 7 and first in (0xF4, 0xF5, 0xF6):
        value = False if first == 0xF4 else True if first == 0xF5 else None
    else:
        raise AssertionError("unsupported CBOR")
    assert cbor(value) == data[start:offset]
    return value, offset


project = "pm:project:v1:" + "a" * 25 + "a"
stream_core = {
    "transport_profile_id": "patchmark/hc2/encrypted-transport/v2",
    "project_id": project,
    "purpose": "replication",
    "sender_person_id": "pm:person:v1:" + "c" * 25 + "a",
    "sender_membership_id": "pm:membership:v1:" + "d" * 25 + "a",
    "sender_device_id": "pm:device:v1:" + "e" * 25 + "a",
    "recipient_person_id": "pm:person:v1:" + "g" * 25 + "a",
    "recipient_membership_id": "pm:membership:v1:" + "h" * 25 + "a",
    "recipient_device_id": "pm:device:v1:" + "j" * 25 + "a",
    "recipient_key_id": "pm:public-key:v1:" + "k" * 25 + "a",
    "stream_generation": 0,
}
assert digest_id("transport-stream", 2, "patchmark/hc2/transport-stream/v2", stream_core) == expected["stream_id"]

markdown = inputs["markdown_text"].encode("utf-8")
markdown_preimage = ["patchmark/markdown-blob/v1", project, markdown]
markdown_digest = hashlib.sha256(cbor(markdown_preimage)).digest()
markdown_suffix = base64.b32encode(markdown_digest).decode("ascii").lower().rstrip("=")
assert f"pm:markdown-blob:v1:{markdown_suffix}" == expected["markdown_blob_id"]

for encoded_hex in expected["hpke_info_hex"] + expected["aad_hex"]:
    encoded = bytes.fromhex(encoded_hex)
    value, end = decode_item(encoded)
    assert end == len(encoded)
    assert cbor(value) == encoded

for aad_hex in expected["aad_hex"]:
    header, _ = decode_item(bytes.fromhex(aad_hex))
    assert set(header) == set(expected["public_header_keys"])
    assert header["envelope_version"] == 2
    assert len(header["encapsulated_key_bytes"]) == 32
    assert len(header["recipient_routing_tag"]) == 32
    serialized = json.dumps(header, default=lambda value: value.hex() if isinstance(value, bytes) else value)
    assert not any(term in serialized for term in ["project_id", "person_id", "membership_id", "control_head", "key_epoch", "purpose", "stream_id"])

assert expected["payload_kinds"] == ["bundle_manifest", "hc1_object_chunk"]
assert expected["signature_preimage_lengths"] == [3052, 2615]
assert all(len(bytes.fromhex(value)) == 32 for value in expected["signature_preimage_sha256"])
assert expected["ciphertext_lengths"] == [length + 16 for length in [3177, 2740]]
assert len(set(expected["encapsulated_key_hex"])) == 2
assert all(len(bytes.fromhex(value)) == 32 for value in expected["encapsulated_key_hex"])
assert expected["bundle_canonical_length"] == 1 + sum(expected["container_canonical_lengths"])
assert expected["derivation_order"].index("sender_signature") < expected["derivation_order"].index("hpke_setup")
assert expected["derivation_order"].index("aad") < expected["derivation_order"].index("seal_once")
assert all(value.startswith("pm:encrypted-container:v2:") for value in expected["container_ids"])
assert not any(":v1:" in value for value in expected["container_ids"])

print(json.dumps({
    "independent_python": True,
    "patchmark_imports": 0,
    "fixture_bytes": len(raw),
    "fixture_sha256": hashlib.sha256(raw).hexdigest(),
    "canonical_values_reencoded": len(expected["hpke_info_hex"]) + len(expected["aad_hex"]),
    "stream_identity_verified": True,
    "markdown_identity_verified": True,
    "public_header_privacy_verified": True,
}, indent=2))

#!/usr/bin/env python3
"""Independent stdlib verifier for the compact HC-3 Slice 3 framing vectors."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIXTURE = json.loads((ROOT / "fixtures" / "collaboration-hc3-slice3-v1.json").read_text("utf-8"))


def head(major: int, value: int) -> bytes:
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + value.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + value.to_bytes(8, "big")


def cbor(value) -> bytes:
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return head(3, len(encoded)) + encoded
    if isinstance(value, int) and value >= 0:
        return head(0, value)
    if isinstance(value, dict):
        entries = [(cbor(key), cbor(child)) for key, child in value.items()]
        entries.sort(key=lambda pair: (len(pair[0]), pair[0]))
        return head(5, len(entries)) + b"".join(key + child for key, child in entries)
    raise TypeError(f"unsupported vector value: {type(value)!r}")


inputs = FIXTURE["inputs"]
expected = FIXTURE["expected"]
descriptor = inputs["payload_descriptor"]
assert descriptor == {"encoding": "counter_modulo", "length": 10003, "modulo": 251}
payload = bytes(index % descriptor["modulo"] for index in range(descriptor["length"]))
assert hashlib.sha256(payload).hexdigest() == expected["payload_sha256"]

attempt = bytes.fromhex(inputs["connection_attempt_id_hex"])
transfer_id = bytes.fromhex(inputs["transfer_id_hex"])
payload_limit = expected["frame_payload_limit"]
frame_count = (len(payload) + payload_limit - 1) // payload_limit
assert frame_count == expected["frame_count"]

frames = []
for ordinal in range(frame_count):
    offset = ordinal * payload_limit
    frame = cbor({
        "schema_version": 1,
        "record_kind": "hc3_direct_frame",
        "connection_attempt_id": attempt,
        "transfer_id": transfer_id,
        "transfer_length": len(payload),
        "transfer_sha256": hashlib.sha256(payload).digest(),
        "frame_ordinal": ordinal,
        "frame_count": frame_count,
        "byte_offset": offset,
        "payload_bytes": payload[offset:offset + payload_limit],
    })
    frames.append(frame)

assert [len(frame) for frame in frames] == expected["frame_lengths"]
assert [hashlib.sha256(frame).hexdigest() for frame in frames] == expected["frame_sha256"]
assert [frame[:24].hex() for frame in frames] == expected["frame_prefix_hex"]

descriptions = []
for item in inputs["descriptions"]:
    encoded = cbor({
        "schema_version": 1,
        "description_kind": item["kind"],
        "sdp_utf8": item["sdp"].encode("utf-8"),
    })
    descriptions.append({
        "kind": item["kind"],
        "canonical_bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    })
assert descriptions == expected["descriptions"]

print(json.dumps({
    "fixture_domain": FIXTURE["fixture_domain"],
    "stdlib_only": True,
    "patchmark_imports": 0,
    "payload_descriptor_expanded": len(payload),
    "frame_count": frame_count,
    "description_vectors": len(descriptions),
    "equivalence": True,
    "status": "ok",
}, indent=2))

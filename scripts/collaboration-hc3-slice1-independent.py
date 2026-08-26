#!/usr/bin/env python3
"""Independent standard-library verifier for HC-3 Slice 1 frozen carriers."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any


FIXTURE = Path(__file__).parent / "fixtures" / "collaboration-hc3-slice1-v1.json"
DOMAIN = "patchmark/hc3/connection-offer-commitment/v1"


def head(major: int, value: int) -> bytes:
    if value < 0:
        raise ValueError("canonical unsigned value is negative")
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + value.to_bytes(4, "big")
    if value <= 0xFFFFFFFFFFFFFFFF:
        return bytes([(major << 5) | 27]) + value.to_bytes(8, "big")
    raise ValueError("canonical unsigned value exceeds uint64")


def canonical(value: Any) -> bytes:
    if value is None:
        return b"\xf6"
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if isinstance(value, int) and not isinstance(value, bool):
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(canonical(child) for child in value)
    if isinstance(value, dict):
        entries = [(canonical(key), canonical(child)) for key, child in value.items()]
        entries.sort(key=lambda entry: entry[0])
        return head(5, len(entries)) + b"".join(key + child for key, child in entries)
    raise TypeError(f"unsupported canonical value: {type(value)!r}")


def crc32c(text: str) -> str:
    crc = 0xFFFFFFFF
    for byte in text.encode("ascii"):
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
    return f"{(crc ^ 0xFFFFFFFF) & 0xFFFFFFFF:08x}"


def artifact_text(tag: str, encoded: bytes) -> str:
    payload = base64.urlsafe_b64encode(encoded).decode("ascii").rstrip("=")
    protected = f"pmhc3.v1.{tag}.{payload}"
    return f"{protected}.{crc32c(protected)}"


def connection(kind: str, fixture: dict[str, Any], offer_commitment: bytes | None) -> dict[str, Any]:
    description_name = "offer_description_hex" if kind == "connection_offer" else "answer_description_hex"
    return {
        "artifact_version": 1,
        "record_kind": "hc3_connection_carrier",
        "artifact_kind": kind,
        "authority": "none",
        "session_id": fixture["session_id"],
        "session_generation": int(fixture["session_generation"]),
        "transport_adapter_tag": bytes.fromhex(fixture["transport_adapter_tag_hex"]),
        "transport_description_bytes": bytes.fromhex(fixture[description_name]),
        "offer_commitment_sha256": offer_commitment,
    }


def vector_actual(fixture: dict[str, Any]) -> dict[str, Any]:
    invitation = fixture["inputs"]["invitation_handoff"]
    invitation_payload = canonical(invitation)
    invitation_carrier = {
        "artifact_version": 1,
        "record_kind": "hc3_handoff_carrier",
        "artifact_kind": "invitation_handoff",
        "authority": "none",
        "payload_protocol": "hc2",
        "payload_encoding": "canonical_cbor",
        "payload_bytes": invitation_payload,
    }
    invitation_bytes = canonical(invitation_carrier)
    invitation_text = artifact_text("ih", invitation_bytes)

    connection_input = fixture["inputs"]["connection"]
    offer = connection("connection_offer", connection_input, None)
    offer_bytes = canonical(offer)
    offer_preimage = canonical([DOMAIN, offer])
    offer_commitment = hashlib.sha256(offer_preimage).digest()
    offer_text = artifact_text("co", offer_bytes)

    answer = connection("connection_answer", connection_input, offer_commitment)
    answer_bytes = canonical(answer)
    answer_text = artifact_text("ca", answer_bytes)

    return {
        "invitation": {
            "hc2_payload_canonical_hex": invitation_payload.hex(),
            "carrier_canonical_hex": invitation_bytes.hex(),
            "carrier_sha256": hashlib.sha256(invitation_bytes).hexdigest(),
            "canonical_text": invitation_text,
            "text_characters": len(invitation_text),
            "link": f"{fixture['inputs']['base_url']}#{invitation_text}",
            "qr_eligible": len(invitation_text) <= 2953,
        },
        "connection_offer": {
            "carrier_canonical_hex": offer_bytes.hex(),
            "carrier_sha256": hashlib.sha256(offer_bytes).hexdigest(),
            "commitment_preimage_hex": offer_preimage.hex(),
            "commitment_sha256": offer_commitment.hex(),
            "canonical_text": offer_text,
            "text_characters": len(offer_text),
            "qr_eligible": len(offer_text) <= 2953,
        },
        "connection_answer": {
            "carrier_canonical_hex": answer_bytes.hex(),
            "carrier_sha256": hashlib.sha256(answer_bytes).hexdigest(),
            "canonical_text": answer_text,
            "text_characters": len(answer_text),
            "qr_eligible": len(answer_text) <= 2953,
        },
    }


def verify_text(expected: dict[str, Any]) -> None:
    for tag, key in (("ih", "invitation"), ("co", "connection_offer"), ("ca", "connection_answer")):
        text = expected[key]["canonical_text"]
        fields = text.split(".")
        assert fields[:3] == ["pmhc3", "v1", tag] and len(fields) == 5
        assert crc32c(".".join(fields[:4])) == fields[4]
        padding = "=" * ((4 - len(fields[3]) % 4) % 4)
        assert base64.urlsafe_b64decode(fields[3] + padding).hex() == expected[key]["carrier_canonical_hex"]


def main() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["fixture_domain"] == "patchmark/hc3/self-contained-handoff-vectors/v1"
    actual = vector_actual(fixture)
    assert actual == fixture["expected"], "independent HC-3 vectors differ from frozen literals"
    verify_text(fixture["expected"])
    print(json.dumps({
        "independent_standard_library_only": True,
        "patchmark_implementation_imports": 0,
        "canonical_carriers": 3,
        "canonical_text_vectors": 3,
        "offer_commitment_domain": DOMAIN,
        "status": "ok",
    }, indent=2))


if __name__ == "__main__":
    main()

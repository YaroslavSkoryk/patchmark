#!/usr/bin/env python3
"""Independent HC-1 review-response evidence verifier (stdlib only)."""

from __future__ import annotations

import hashlib
import json
import pathlib
import unicodedata


FIXTURE = (
    pathlib.Path(__file__).with_name("fixtures")
    / "collaboration-review-response-evidence-v1.json"
)


def cbor_head(major: int, value: int) -> bytes:
    if value < 0 or value >= 2**64:
        raise ValueError("canonical integer outside uint64")
    prefix = major << 5
    if value < 24:
        return bytes([prefix | value])
    if value <= 0xFF:
        return bytes([prefix | 24, value])
    if value <= 0xFFFF:
        return bytes([prefix | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([prefix | 26]) + value.to_bytes(4, "big")
    return bytes([prefix | 27]) + value.to_bytes(8, "big")


def cbor(value) -> bytes:
    if isinstance(value, int) and not isinstance(value, bool):
        return cbor_head(0, value)
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise ValueError("canonical text must be NFC")
        encoded = value.encode("utf-8")
        return cbor_head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return cbor_head(4, len(value)) + b"".join(cbor(child) for child in value)
    if isinstance(value, dict):
        entries = [(cbor(key), cbor(child)) for key, child in value.items()]
        entries.sort(key=lambda entry: entry[0])
        return cbor_head(5, len(entries)) + b"".join(
            key + child for key, child in entries
        )
    raise TypeError(f"unsupported canonical value: {type(value)!r}")


def main() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    contributions = sorted(fixture["contribution_payload_ids"])
    if len(contributions) != len(set(contributions)):
        raise AssertionError("fixture contribution IDs are not unique")
    preimage = cbor([
        fixture["domain"],
        {
            "schema_version": fixture["schema_version"],
            "project_id": fixture["project_id"],
            "review_batch_id": fixture["review_batch_id"],
            "response_import_id": fixture["response_import_id"],
            "contribution_payload_ids": contributions,
        },
    ])
    commitment = hashlib.sha256(preimage).hexdigest()
    if preimage.hex() != fixture["canonical_preimage_hex"]:
        raise AssertionError("independent canonical preimage mismatch")
    if commitment != fixture["commitment"]:
        raise AssertionError("independent evidence commitment mismatch")
    print(json.dumps({
        "independent": True,
        "schema_version": fixture["schema_version"],
        "canonical_preimage_bytes": len(preimage),
        "commitment": commitment,
    }, indent=2))


if __name__ == "__main__":
    main()

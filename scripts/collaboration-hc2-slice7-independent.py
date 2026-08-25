#!/usr/bin/env python3
"""Independent HC-2 synchronization-v3 verifier; imports no Patchmark code."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib

FIXTURE = pathlib.Path(__file__).with_name("fixtures") / "collaboration-hc2-slice7-v3.json"
raw = FIXTURE.read_bytes()
fixture = json.loads(raw)
inputs = fixture["inputs"]
expected = fixture["expected"]
assert fixture["fixture_version"] == 3
assert len(raw) < 2 * 1024 * 1024
assert b"18874384" not in raw


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
        return head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(cbor(child) for child in value)
    if isinstance(value, dict):
        entries = sorted(((cbor(key), cbor(child)) for key, child in value.items()), key=lambda pair: pair[0])
        return head(5, len(entries)) + b"".join(key + child for key, child in entries)
    raise TypeError(type(value))


def suffix(data):
    return base64.b32encode(hashlib.sha256(data).digest()).decode("ascii").lower().rstrip("=")


def identity(kind, version, domain, core):
    return f"pm:{kind}:v{version}:" + suffix(cbor([domain, core]))


def entity(kind, fill):
    return f"pm:{kind}:v1:" + fill * 25 + "a"


def digest_id(kind, fill, version=1):
    return f"pm:{kind}:v{version}:" + fill * 51 + "a"


project = entity("project", "a")
sender_device = entity("device", "e")
recipient_device = entity("device", "j")
semantic = digest_id("semantic-event", "q")
control = digest_id("control-event", "n")
epoch = entity("key-epoch", "m")
epoch_commitment = digest_id("key-epoch-commitment", "p")
projection = digest_id("projection-root", "r")
markdown = inputs["markdown_text"].encode()
markdown_id = "pm:markdown-blob:v1:" + suffix(cbor(["patchmark/markdown-blob/v1", project, markdown]))
receipt = b"receipt-a"
receipt_id = "pm:transport-attachment:v2:" + suffix(receipt)

descriptors = [
    {"schema_version": 3, "record_kind": "inventory_descriptor_v3", "authority": "none", "storage_family": "hc1", "object_kind": "markdown-blob", "object_id": markdown_id, "exact_sha256": hashlib.sha256(markdown).digest(), "exact_byte_length": len(markdown)},
    {"schema_version": 3, "record_kind": "inventory_descriptor_v3", "authority": "none", "storage_family": "hc1", "object_kind": "semantic-event", "object_id": semantic, "exact_sha256": hashlib.sha256(b"concurrent-event-a").digest(), "exact_byte_length": 18},
    {"schema_version": 3, "record_kind": "inventory_descriptor_v3", "authority": "none", "storage_family": "hc2_attachment", "object_kind": "receipt_attachment", "object_id": receipt_id, "exact_sha256": hashlib.sha256(receipt).digest(), "exact_byte_length": len(receipt)},
]
descriptors.sort(key=lambda item: f'{item["storage_family"]}\0{item["object_kind"]}\0{item["object_id"]}')
descriptor_keys = [f'{item["storage_family"]}\0{item["object_kind"]}\0{item["object_id"]}' for item in descriptors]
assert descriptor_keys == expected["descriptor_keys"]
assert [item["exact_sha256"].hex() for item in descriptors] == expected["descriptor_sha256"]

inventory_root_core = {"schema_version": 3, "record_kind": "inventory_root_core_v3", "project_id": project, "descriptors": descriptors}
inventory_root = identity("inventory-root", 3, "patchmark/hc2/sync/inventory-root/v3", inventory_root_core)
assert inventory_root == expected["inventory_root_id"]

snapshot_core = {
    "schema_version": 3, "record_kind": "inventory_snapshot_core_v3", "authority": "none", "project_id": project,
    "portable_generation": 7, "accepted_control_head_id": control, "key_epoch_id": epoch,
    "key_epoch_commitment": epoch_commitment, "semantic_frontier": [semantic], "checkpoint_id": semantic,
    "projection_root_id": projection, "descriptor_count": 3, "page_count": 1, "inventory_root_id": inventory_root,
    "protocol_version": "hc1-v1", "reducer_version": "hc1-reducer-v1",
}
snapshot_id = identity("inventory-snapshot", 3, "patchmark/hc2/sync/inventory-snapshot/v3", snapshot_core)
assert snapshot_id == expected["inventory_snapshot_id"]

session_core = {"transport_profile_id": "patchmark/hc2/encrypted-synchronization/v3", "project_id": project, "initiator_device_id": sender_device, "responder_device_id": recipient_device, "session_generation": 0}
session_id = identity("sync-session", 3, "patchmark/hc2/sync/session/v3", session_core)
assert session_id == expected["session_id"]

page_digest = hashlib.sha256(cbor(descriptors)).digest()
page_core = {
    "schema_version": 3, "record_kind": "inventory_page_core_v3", "authority": "none", "session_id": session_id,
    "session_generation": 0, "round_number": 1, "inventory_snapshot_id": snapshot_id, "page_ordinal": 0,
    "page_count": 1, "first_descriptor_key": descriptor_keys[0], "last_descriptor_key": descriptor_keys[-1],
    "descriptor_count": 3, "descriptors": descriptors, "page_digest": page_digest,
}
assert page_digest.hex() == expected["inventory_page_digests"][0]
assert identity("inventory-page", 3, "patchmark/hc2/sync/inventory-page/v3", page_core) == expected["inventory_page_ids"][0]

stream_core = {"transport_profile_id": "patchmark/hc2/encrypted-synchronization/v3", "purpose": "synchronization", "project_id": project, "sender_device_id": sender_device, "recipient_device_id": recipient_device, "session_id": session_id, "stream_generation": 0}
assert identity("transport-stream", 3, "patchmark/hc2/sync/transport-stream/v3", stream_core) == expected["stream_id"]

request_item = {"storage_family": descriptors[0]["storage_family"], "object_kind": descriptors[0]["object_kind"], "object_id": descriptors[0]["object_id"], "expected_sha256": descriptors[0]["exact_sha256"], "expected_byte_length": descriptors[0]["exact_byte_length"]}
request_core = {"schema_version": 3, "record_kind": "object_request_core_v3", "authority": "none", "session_id": session_id, "session_generation": 0, "round_number": 2, "local_snapshot_id": snapshot_id, "remote_snapshot_id": snapshot_id, "request_page_ordinal": 0, "request_page_count": 1, "maximum_object_count": 1, "maximum_total_bytes": 1024, "dependency_policy": "required_closure", "items": [request_item]}
request_id = identity("object-request", 3, "patchmark/hc2/sync/object-request/v3", request_core)
assert request_id == expected["request_id"]
response_core = {"schema_version": 3, "record_kind": "object_response_core_v3", "authority": "none", "session_id": session_id, "session_generation": 0, "round_number": 2, "request_id": request_id, "local_snapshot_id": snapshot_id, "remote_snapshot_id": snapshot_id, "included_descriptors": [descriptors[0]], "unavailable_descriptor_keys": [], "continuation_required": False, "continuation_after_key": None}
assert identity("object-response", 3, "patchmark/hc2/sync/object-response/v3", response_core) == expected["response_id"]

reconstruction = {
    "accepted_object_set_commitment": digest_id("accepted-object-set", "q", 3), "semantic_frontier": [semantic],
    "accepted_semantic_set_commitment": digest_id("semantic-set", "r", 3), "accepted_control_set_commitment": digest_id("control-set", "s", 3),
    "accepted_control_head_id": control, "authority_state_commitment": digest_id("authority-state", "t", 3),
    "key_epoch_id": epoch, "key_epoch_commitment": epoch_commitment, "canonical_projection_commitment": digest_id("canonical-projection", "u", 3),
    "revision_heads_root_id": digest_id("revision-heads-root", "s"), "conflict_root_id": digest_id("conflict-set-root", "t"),
    "tombstone_root_id": digest_id("tombstone-root", "v", 3), "reducer_rejection_root_id": digest_id("reducer-rejection-root", "w", 3),
    "component_roots_commitment": digest_id("component-roots", "x", 3), "projection_root_id": projection,
    "checkpoint_id": semantic, "shared_state_commitment": digest_id("shared-state", "y", 3),
    "acknowledgement_receipt_commitment": digest_id("ack-receipt", "z", 3), "protocol_version": "hc1-v1", "reducer_version": "hc1-reducer-v1",
}
confirmation_core = {"schema_version": 3, "record_kind": "sync_confirmation_core_v3", "authority": "none", "session_id": session_id, "session_generation": 0, "round_number": 3, "inventory_snapshot_id": snapshot_id, "inventory_root_id": inventory_root, "inventory_descriptor_count": 3, "reconstruction": reconstruction}
assert identity("sync-confirmation", 3, "patchmark/hc2/sync/confirmation/v3", confirmation_core) == expected["confirmation_id"]

for encoded_hex in expected["hpke_info_hex"] + expected["aad_hex"]:
    encoded = bytes.fromhex(encoded_hex)
    assert len(encoded) > 0 and hashlib.sha256(encoded).digest()
for aad_hex in expected["aad_hex"]:
    encoded = bytes.fromhex(aad_hex)
    assert b"project_id" not in encoded and b"session_id" not in encoded and b"inventory" not in encoded and b"request" not in encoded
    assert b"PATCHMARK-HC2-BUNDLE" in encoded
assert expected["public_header_keys"] == sorted(["magic", "envelope_version", "suite_id", "encapsulated_key_bytes", "envelope_id", "recipient_routing_tag", "chunk_ordinal", "chunk_count", "ciphertext_length"])
assert expected["authority_values"] == ["none"] * 5
assert expected["payload_kinds"] == ["bundle_manifest", "sync_offer"]
assert expected["ciphertext_lengths"] == [length + 16 for length in [3482, 2912]]
assert len(set(expected["encapsulated_key_hex"])) == 2
assert expected["bundle_canonical_length"] == 1 + sum(expected["container_canonical_lengths"])
assert expected["convergence_status"] == "converged"
assert expected["reconstruction_divergence_status"] == "more_required"
assert (expected["replay_status"], expected["gap_status"], expected["stream_fork_status"]) == ("duplicate", "retryable_gap", "stream_fork")

print(json.dumps({
    "independent_python": True,
    "patchmark_imports": 0,
    "fixture_bytes": len(raw),
    "fixture_sha256": hashlib.sha256(raw).hexdigest(),
    "descriptor_order_verified": True,
    "inventory_snapshot_page_session_stream_ids_verified": True,
    "request_response_confirmation_ids_verified": True,
    "public_header_privacy_verified": True,
}, indent=2))

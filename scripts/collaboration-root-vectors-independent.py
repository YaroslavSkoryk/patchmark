#!/usr/bin/env python3
"""Independent Slice 6 verifier using only the Python standard library."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import unicodedata


FIXTURE = pathlib.Path(__file__).with_name("fixtures") / "collaboration-roots-v1.json"


def cbor_head(major: int, value: int) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value >= 2**64:
        raise ValueError("canonical unsigned integer is outside uint64")
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
    if value is None:
        return b"\xf6"
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if isinstance(value, int):
        return cbor_head(0, value)
    if isinstance(value, bytes):
        return cbor_head(2, len(value)) + value
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise ValueError("text is not NFC")
        encoded = value.encode("utf-8")
        return cbor_head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return cbor_head(4, len(value)) + b"".join(cbor(child) for child in value)
    if isinstance(value, dict):
        encoded = [(cbor(key), cbor(child)) for key, child in value.items()]
        if any(not isinstance(key, str) for key in value):
            raise ValueError("Patchmark maps require text keys")
        encoded.sort(key=lambda entry: entry[0])
        return cbor_head(5, len(encoded)) + b"".join(key + child for key, child in encoded)
    raise TypeError(f"unsupported canonical type: {type(value)!r}")


def digest(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()


def display_id(kind: str, raw: bytes) -> str:
    suffix = base64.b32encode(raw).decode("ascii").lower().rstrip("=")
    return f"pm:{kind}:v1:{suffix}"


def merkle(family: str, kind: str, entries: list[dict]) -> bytes:
    leaves = []
    for entry in entries:
        key = cbor(entry["key"])
        value = None if kind == "set" else cbor(entry["value"])
        leaves.append((key, value))
    leaves.sort(key=lambda entry: entry[0])
    if any(leaves[index - 1][0] == leaves[index][0] for index in range(1, len(leaves))):
        raise ValueError("duplicate canonical keys")
    if not leaves:
        return digest(cbor(["patchmark/merkle-empty/v1", family, kind]))
    level = [
        digest(cbor([
            "patchmark/merkle-set-leaf/v1" if kind == "set" else "patchmark/merkle-map-leaf/v1",
            family,
            key,
            *([] if kind == "set" else [value]),
        ]))
        for key, value in leaves
    ]
    level_index = 0
    while len(level) > 1:
        next_level = []
        for index in range(0, len(level), 2):
            right = [] if index + 1 == len(level) else [level[index + 1]]
            next_level.append(digest(cbor([
                "patchmark/merkle-internal/v1",
                family,
                kind,
                level_index,
                index // 2,
                level[index],
                right,
            ])))
        level = next_level
        level_index += 1
    return level[0]


ROOT_KIND = {
    "base_frontier": "frontier-root",
    "accepted_history": "accepted-history-root",
    "semantic_state": "semantic-state-root",
    "revision_heads": "revision-heads-root",
    "conflict_set": "conflict-set-root",
}


def root_result(family: str, kind: str, entries: list[dict]) -> tuple[dict, bytes]:
    raw = merkle(family, kind, entries)
    return ({
        "entry_count": len(entries),
        "root_hex": raw.hex(),
        "root_id": display_id(ROOT_KIND[family], raw),
    }, raw)


def identity_result(kind: str, canonical: bytes) -> tuple[dict, bytes, str]:
    raw = digest(canonical)
    identity = display_id(kind, raw)
    return ({"digest_hex": raw.hex(), "id": identity}, raw, identity)


def semantic_project_entry(projection: dict) -> dict:
    title = projection["project_title"]
    semantic_title = {
        "register_version": title["register_version"],
        "state": title["state"],
        "resolved_value": title["resolved_value"],
        "last_uncontested_value": title["last_uncontested_value"],
        "contender_values": sorted(contender["value"] for contender in title["contenders"]),
    }
    return {
        "key": ["project", projection["project_id"]],
        "value": {
            "project_id": projection["project_id"],
            "title": semantic_title,
            "group_order": projection["group_order"],
            "document_order": projection["document_order"],
        },
    }


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label} mismatch\nexpected={expected!r}\nactual={actual!r}")


def main() -> None:
    vectors = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = vectors["expected"]
    actual_merkle = {}
    for vector in vectors["merkle_vectors"]:
        raw = merkle(vector["family"], vector["kind"], vector["entries"])
        result = {"entry_count": len(vector["entries"]), "root_hex": raw.hex()}
        if "root_id_kind" in vector:
            result["root_id"] = display_id(vector["root_id_kind"], raw)
        actual_merkle[vector["name"]] = result
    assert_equal(actual_merkle, expected["merkle"], "Merkle vectors")

    try:
        duplicate = vectors["duplicate_key_case"]
        merkle(duplicate["family"], duplicate["kind"], duplicate["entries"])
    except ValueError as error:
        if "duplicate canonical keys" not in str(error):
            raise
    else:
        raise AssertionError("duplicate canonical key was accepted")

    ids = vectors["ids"]
    component_input = vectors["component_inputs"]
    base_entries = [{"key": event_id} for event_id in component_input["base_frontier_event_ids"]]
    base, base_raw = root_result("base_frontier", "set", base_entries)
    history_entries = [
        {"key": event["event_id"], "value": event["author_attestation_id"]}
        for event in component_input["accepted_events"]
    ]
    history, history_raw = root_result("accepted_history", "map", history_entries)
    semantic_entries = [semantic_project_entry(component_input["projection"])]
    semantic, semantic_raw = root_result("semantic_state", "map", semantic_entries)
    revisions, revisions_raw = root_result("revision_heads", "map", [])
    conflicts, conflicts_raw = root_result("conflict_set", "map", [])
    components = {
        "base_frontier": base,
        "accepted_history": history,
        "semantic_state": semantic,
        "revision_heads": revisions,
        "conflict_set": conflicts,
    }
    assert_equal(components, expected["component_roots"], "component roots")

    epoch_value = {
        "schema_version": 1,
        "object_kind": "key_epoch_public_commitment",
        "project_id": ids["project"],
        "key_epoch_id": ids["key_epoch"],
        "commitment_algorithm": "sha256-public-commitment-v1",
        "public_commitment_bytes": bytes.fromhex(vectors["key_epoch"]["public_commitment_hex"]),
    }
    epoch_canonical = cbor(["patchmark/key-epoch-commitment/v1", epoch_value])
    epoch, _, epoch_id = identity_result("key-epoch-commitment", epoch_canonical)
    epoch["canonical_hex"] = epoch_canonical.hex()
    epoch = {"canonical_hex": epoch.pop("canonical_hex"), **epoch}
    assert_equal(epoch, expected["key_epoch"], "key-epoch commitment")

    control_value = dict(vectors["control_state"])
    control_value["key_epoch_commitment"] = epoch_id
    control_value["device_authorities"] = [dict(entry) for entry in control_value["device_authorities"]]
    for authority in control_value["device_authorities"]:
        authority["capabilities"] = sorted(authority["capabilities"])
    control_value["device_authorities"].sort(key=lambda entry: entry["device_id"])
    control_canonical = cbor(["patchmark/control-state-root/v1", control_value])
    control, _, _ = identity_result("control-state-root", control_canonical)
    assert_equal(control, expected["control_state"], "control-state commitment")

    operations = vectors["resolution_operations"]
    resolution_canonical = cbor(["patchmark/resolution-operations/v1", operations])
    resolution_raw = digest(resolution_canonical)
    resolution = {
        "canonical_hex": resolution_canonical.hex(),
        "digest_hex": resolution_raw.hex(),
    }
    assert_equal(resolution, expected["resolution_operations"], "resolution operations")

    composite_canonical = cbor([
        "patchmark/projection-root/v1",
        ids["project"],
        "patchmark-hc-reducer-v1",
        ids["control_head"],
        base_raw,
        history_raw,
        semantic_raw,
        revisions_raw,
        conflicts_raw,
        resolution_raw,
    ])
    composite, _, composite_id = identity_result("projection-root", composite_canonical)
    composite["canonical_hex"] = composite_canonical.hex()
    composite = {"canonical_hex": composite.pop("canonical_hex"), **composite}
    assert_equal(composite, expected["composite_projection"], "composite projection root")

    state_core = {
        "schema_version": 1,
        "object_kind": "canonical_state_blob_core",
        "project_id": ids["project"],
        "reducer_version": "patchmark-hc-reducer-v1",
        "checkpoint_id": ids["checkpoint"],
        "control_head_id": ids["control_head"],
        "semantic_state_root": semantic["root_id"],
        "revision_heads_root": revisions["root_id"],
        "conflict_set_root": conflicts["root_id"],
        "projection_root": composite_id,
        "projection": component_input["projection"],
    }
    state, _, state_id = identity_result(
        "state-blob", cbor(["patchmark/state-blob/v1", state_core])
    )
    assert_equal(state, expected["state_blob"], "state-blob identity")

    snapshot_core = {
        "schema_version": 1,
        "object_kind": "projection_snapshot_core",
        "project_id": ids["project"],
        "checkpoint_id": ids["checkpoint"],
        "reducer_version": "patchmark-hc-reducer-v1",
        "state_blob_id": state_id,
        "semantic_state_root": semantic["root_id"],
        "revision_heads_root": revisions["root_id"],
        "conflict_set_root": conflicts["root_id"],
        "projection_root": composite_id,
        "boundary_revisions": vectors["snapshot"]["boundary_revisions"],
        "live_conflict_dependencies": vectors["snapshot"]["live_conflict_dependencies"],
    }
    snapshot, _, snapshot_id = identity_result(
        "snapshot", cbor(["patchmark/snapshot-core/v1", snapshot_core])
    )
    assert_equal(snapshot, expected["snapshot"], "snapshot identity")

    acknowledgement_core = dict(vectors["acknowledgement"])
    acknowledgement_core["projection_root"] = composite_id
    acknowledgement = cbor(["patchmark/ack-core/v1", acknowledgement_core])
    acknowledgement_result, acknowledgement_raw, acknowledgement_id = identity_result(
        "acknowledgement", acknowledgement
    )
    acknowledgement_result["signature_preimage_hex"] = cbor([
        "patchmark/signature/acknowledgement/v1",
        ids["project"],
        acknowledgement_raw,
    ]).hex()
    assert_equal(acknowledgement_result, expected["acknowledgement"], "acknowledgement identity")

    verification = {
        "complete_checkpoint": {
            "status": "full_history_verified",
            "checkpoint_id": ids["checkpoint"],
            "projection_root": composite_id,
        },
        "onboarding_boundary": {
            "status": "owner_authorized_boundary_verified",
            "checkpoint_id": ids["checkpoint"],
            "snapshot_id": snapshot_id,
            "full_history_verified": False,
            "verification_basis": "owner_authorized_current_state",
        },
    }
    assert_equal(verification, expected["verification_cases"], "verification boundary cases")

    print(json.dumps({
        "implementation": "python-standard-library-only",
        "merkle_vectors": len(vectors["merkle_vectors"]),
        "component_roots": len(components),
        "canonical_identity_vectors": 7,
        "verification_cases": len(verification),
        "patchmark_imports": 0,
    }, indent=2))


if __name__ == "__main__":
    main()

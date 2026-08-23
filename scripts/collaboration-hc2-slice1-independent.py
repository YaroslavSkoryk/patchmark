#!/usr/bin/env python3
"""Independent HC-2 Slice 1 vector verifier using only Python's standard library."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import unicodedata


FIXTURE = pathlib.Path(__file__).with_name("fixtures") / "collaboration-hc2-slice1-v1.json"
KIB = 1024
MIB = KIB * KIB
MAXIMUM_SIGNED_RECORD_BYTES = 18 * MIB
AES_256_GCM_TAG_BYTES = 16
MAXIMUM_CIPHERTEXT_BYTES = MAXIMUM_SIGNED_RECORD_BYTES + AES_256_GCM_TAG_BYTES
MAXIMUM_CONTAINER_BYTES = 18 * MIB + 64 * KIB
MAXIMUM_BUNDLE_BYTES = 256 * MIB


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
        if any(not isinstance(key, str) for key in value):
            raise ValueError("Patchmark maps require text keys")
        encoded = sorted((cbor(key), cbor(child)) for key, child in value.items())
        return cbor_head(5, len(encoded)) + b"".join(key + child for key, child in encoded)
    raise TypeError(f"unsupported canonical type: {type(value)!r}")


def digest(raw: bytes) -> bytes:
    return hashlib.sha256(raw).digest()


def display_id(kind: str, raw: bytes) -> str:
    suffix = base64.b32encode(raw).decode("ascii").lower().rstrip("=")
    return f"pm:{kind}:v1:{suffix}"


def identity(kind: str, domain: str, core) -> tuple[str, bytes]:
    preimage = cbor([domain, core])
    return display_id(kind, digest(preimage)), preimage


def summary(raw: bytes) -> dict:
    return {"byte_length": len(raw), "sha256_hex": digest(raw).hex()}


def aes_gcm_ciphertext_length(plaintext_record_bytes: int, suite_id: str) -> int:
    if suite_id != "patchmark/hc2/crypto-suite/v1":
        raise ValueError("unknown suite")
    if not isinstance(plaintext_record_bytes, int) or isinstance(plaintext_record_bytes, bool):
        raise ValueError("unsafe length")
    if plaintext_record_bytes < 0 or plaintext_record_bytes > MAXIMUM_SIGNED_RECORD_BYTES:
        raise ValueError("signed record outside limit")
    return plaintext_record_bytes + AES_256_GCM_TAG_BYTES


def portable_bundle_length(container_record_lengths: list[int]) -> int:
    if not container_record_lengths or len(container_record_lengths) > 4096:
        raise ValueError("invalid container count")
    array_header = len(cbor_head(4, len(container_record_lengths)))
    total = array_header
    for length in container_record_lengths:
        if not isinstance(length, int) or isinstance(length, bool) or length <= 0:
            raise ValueError("invalid container length")
        if length > MAXIMUM_CONTAINER_BYTES + 1024:
            raise ValueError("container outside limit")
        total += length
        if total > MAXIMUM_BUNDLE_BYTES:
            raise ValueError("bundle outside limit")
    return total


def main() -> None:
    vectors = json.loads(FIXTURE.read_text(encoding="utf-8"))
    ids = vectors["ids"]
    fixed = vectors["fixed_bytes"]
    markdown = bytes.fromhex(vectors["markdown_utf8_hex"])
    stored_digest = digest(markdown)
    markdown_id = display_id(
        "markdown-blob",
        digest(cbor(["patchmark/markdown-blob/v1", ids["project"], markdown])),
    )

    object_marker = {
        "schema_version": 1,
        "record_kind": "portable_object_commit_marker",
        "project_id": ids["project"],
        "object_kind": "markdown-blob",
        "object_id": markdown_id,
        "stored_length": len(markdown),
        "stored_sha256": stored_digest,
    }
    marker_id, marker_preimage = identity(
        "object-commit-marker", "patchmark/hc2/object-commit-marker/v1", object_marker
    )

    writer_core = {
        "schema_version": 1,
        "record_kind": "writer_continuity_evidence",
        "project_id": ids["project"],
        "device_id": ids["device"],
        "evidence_sequence": 0,
        "previous_continuity_id": None,
        "transition": "same_device_continuation",
        "previous_device_id": None,
        "operation_id": vectors["operation_id"],
        "predecessor_batch_id": None,
        "authority": "operational_evidence_only",
    }
    writer_record = {
        "core": writer_core,
        "signer_device_id": ids["device"],
        "signature_algorithm": "ed25519",
        "signature_bytes": bytes.fromhex(fixed["writer_signature_hex"]),
    }
    writer_id, writer_preimage = identity(
        "writer-continuity", "patchmark/hc2/writer-continuity/v1", writer_record
    )

    batch_entries = [{
        "object_kind": "markdown-blob",
        "object_id": markdown_id,
        "stored_length": len(markdown),
        "stored_sha256": stored_digest,
        "dependency_ids": [],
        "object_commit_marker_id": marker_id,
    }]
    batch_root = digest(cbor(["patchmark/hc2/batch-object-root/v1", batch_entries]))
    batch_core = {
        "schema_version": 1,
        "record_kind": "portable_batch_marker",
        "project_id": ids["project"],
        "predecessor_batch_id": None,
        "object_entries": batch_entries,
        "batch_root": batch_root,
        "writer_continuity_id": writer_id,
        "storage_schema_version": 1,
        "protocol_version": 1,
        "recovery_policy": "mandatory_before_collaboration",
    }
    batch_id, batch_preimage = identity(
        "portable-batch", "patchmark/hc2/portable-batch/v1", batch_core
    )

    transaction_core = {
        "schema_version": 1,
        "record_kind": "transaction_intent",
        "project_id": ids["project"],
        "device_id": ids["device"],
        "operation_id": vectors["operation_id"],
        "expected_generation": 0,
        "expected_sequence": None,
        "expected_previous_object_id": None,
        "planned_objects": [{
            "object_kind": "markdown-blob",
            "object_id": markdown_id,
            "signed_bytes_commitment": stored_digest,
        }],
        "intended_batch_id": batch_id,
        "state": "pending",
        "authority": "local_transactional_only",
    }
    transaction_id, transaction_preimage = identity(
        "transaction-intent", "patchmark/hc2/transaction-intent/v1", transaction_core
    )

    replica = {
        "schema_version": 1,
        "record_kind": "portable_replica_metadata",
        "project_id": ids["project"],
        "collaboration_schema_version": 1,
        "storage_schema_version": 1,
        "addressing_version": 1,
        "protocol_name": "patchmark.human-collaboration",
        "protocol_version": 1,
        "bootstrap_control_event_id": ids["control_head"],
        "at_rest_disclosure_version": 1,
        "recovery_policy": "mandatory_before_collaboration",
    }
    recovery = {
        "schema_version": 1,
        "record_kind": "recovery_recipient_epoch_envelope",
        "project_id": ids["project"],
        "key_epoch_id": ids["key_epoch"],
        "recipient_kind": "person_recovery_key",
        "recipient_key_id": ids["recovery_key"],
        "suite_id": "patchmark/hc2/crypto-suite/v1",
        "encrypted_epoch_bytes": bytes.fromhex(fixed["recovery_envelope_hex"]),
        "authority": "portable_encrypted_recovery",
    }
    recovery_id, recovery_preimage = identity(
        "recovery-envelope", "patchmark/hc2/recovery-envelope/v1", recovery
    )
    materialization = {
        "schema_version": 1,
        "record_kind": "materialization_status",
        "project_id": ids["project"],
        "projection_root_id": ids["projection_root"],
        "checkpoint_id": ids["checkpoint"],
        "expected_document_sha256": stored_digest,
        "status": "complete",
        "failure_code": None,
        "authority": "materialized_projection_only",
    }

    manifest = [{
        "object_kind": "markdown-blob",
        "object_id": markdown_id,
        "byte_length": len(markdown),
        "stored_sha256": stored_digest,
        "dependency_ids": [],
        "dependency_depth": 0,
    }]
    chunk = {
        "schema_version": 1,
        "record_kind": "chunk_payload_core",
        "project_id": ids["project"],
        "scope_id": ids["access_scope"],
        "sender_person_id": ids["person"],
        "sender_device_id": ids["device"],
        "recipient_device_id": ids["recipient_device"],
        "recipient_key_id": ids["recipient_key"],
        "key_epoch_id": ids["key_epoch"],
        "accepted_control_head_id": ids["control_head"],
        "bundle_kind": "collaboration_exchange",
        "limit_profile_id": "patchmark/hc2/limits/v1",
        "manifest": manifest,
        "object_bytes": [{
            "object_kind": "markdown-blob",
            "object_id": markdown_id,
            "exact_bytes": markdown,
        }],
    }
    chunk_id, chunk_preimage = identity(
        "chunk-commitment", "patchmark/hc2/chunk-commitment/v1", chunk
    )
    bundle_core = {
        "schema_version": 1,
        "record_kind": "bundle_root_core",
        "chunk_commitment_ids": [chunk_id],
    }
    bundle_id, bundle_preimage = identity(
        "bundle-root", "patchmark/hc2/bundle-root/v1", bundle_core
    )
    signed_core = {
        "schema_version": 1,
        "record_kind": "signed_plaintext_core",
        "payload_core": chunk,
        "bundle_root_id": bundle_id,
        "chunk_ordinal": 0,
        "chunk_count": 1,
    }
    signed_record = {
        "record_version": 1,
        "record_kind": "signed_plaintext_record",
        "core": signed_core,
        "sender_device_signature": {
            "algorithm": "ed25519",
            "signer_device_id": ids["device"],
            "signer_key_id": ids["signing_key"],
            "signature_bytes": bytes.fromhex(fixed["envelope_signature_hex"]),
        },
    }
    ciphertext = bytes.fromhex(fixed["ciphertext_hex"])
    header = {
        "magic": "PATCHMARK-HC2-BUNDLE",
        "envelope_version": 1,
        "suite_id": "patchmark/hc2/crypto-suite/v1",
        "encapsulated_key_bytes": bytes.fromhex(fixed["hpke_enc_hex"]),
        "envelope_id": vectors["envelope_id"],
        "recipient_routing_tag": bytes.fromhex(fixed["recipient_tag_hex"]),
        "chunk_ordinal": 0,
        "chunk_count": 1,
        "ciphertext_length": len(ciphertext),
    }
    aad = cbor(header)
    info = cbor([
        "patchmark/hc2/hpke-info/v1", 1, "patchmark/hc2/crypto-suite/v1",
        vectors["envelope_id"], bytes.fromhex(fixed["recipient_tag_hex"]), 0, 1,
    ])
    writer_signature = cbor([
        "patchmark/hc2/signature/writer-continuity/v1", writer_core
    ])
    sender_signature = cbor([
        "patchmark/hc2/signature/envelope-chunk/v1", digest(aad), signed_core
    ])
    container_core = {
        "container_version": 1,
        "record_kind": "encrypted_container_core",
        "public_header": header,
        "ciphertext": ciphertext,
    }
    container_id, container_preimage = identity(
        "encrypted-container", "patchmark/hc2/encrypted-container/v1", container_core
    )

    maximum_ciphertext = aes_gcm_ciphertext_length(
        MAXIMUM_SIGNED_RECORD_BYTES, "patchmark/hc2/crypto-suite/v1"
    )
    if maximum_ciphertext != MAXIMUM_CIPHERTEXT_BYTES:
        raise AssertionError("AES-256-GCM contract formula changed")
    if maximum_ciphertext + 4096 + (60 * KIB - 16) != MAXIMUM_CONTAINER_BYTES:
        raise AssertionError("encrypted-container byte derivation changed")
    maximum_bundle_lengths = []
    remaining_bundle = MAXIMUM_BUNDLE_BYTES - 1
    while remaining_bundle > MAXIMUM_CONTAINER_BYTES:
        maximum_bundle_lengths.append(MAXIMUM_CONTAINER_BYTES)
        remaining_bundle -= MAXIMUM_CONTAINER_BYTES
    maximum_bundle_lengths.append(remaining_bundle)
    if portable_bundle_length(maximum_bundle_lengths) != MAXIMUM_BUNDLE_BYTES:
        raise AssertionError("portable-bundle exact boundary changed")
    try:
        portable_bundle_length(maximum_bundle_lengths[:-1] + [maximum_bundle_lengths[-1] + 1])
    except ValueError:
        pass
    else:
        raise AssertionError("oversized portable bundle was accepted")
    try:
        aes_gcm_ciphertext_length(1, "patchmark/hc2/crypto-suite/v2")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown suite reused the v1 ciphertext formula")

    canonical_cores = {
        "replica": summary(cbor(replica)),
        "object_commit_marker": summary(cbor(object_marker)),
        "writer_continuity": summary(cbor(writer_record)),
        "portable_batch": summary(cbor(batch_core)),
        "transaction_intent": summary(cbor(transaction_core)),
        "recovery_envelope": summary(cbor(recovery)),
        "materialization_status": summary(cbor(materialization)),
        "chunk_payload": summary(cbor(chunk)),
        "bundle_root": summary(cbor(bundle_core)),
        "signed_plaintext_core": summary(cbor(signed_core)),
        "signed_plaintext_record": summary(cbor(signed_record)),
        "public_header": summary(aad),
        "encrypted_container_core": summary(cbor(container_core)),
    }

    def identity_result(identity_value: str, preimage: bytes) -> dict:
        return {"id": identity_value, "canonical_preimage": summary(preimage)}

    actual = {
        "domains": {
            "hpke_info": "patchmark/hc2/hpke-info/v1",
            "signature": "patchmark/hc2/signature/envelope-chunk/v1",
        },
        "canonical_cores": canonical_cores,
        "identities": {
            "markdown_blob_id": markdown_id,
            "object_commit_marker": identity_result(marker_id, marker_preimage),
            "portable_batch": identity_result(batch_id, batch_preimage),
            "writer_continuity": identity_result(writer_id, writer_preimage),
            "recovery_envelope": identity_result(recovery_id, recovery_preimage),
            "transaction_intent": identity_result(transaction_id, transaction_preimage),
            "chunk_commitment": identity_result(chunk_id, chunk_preimage),
            "bundle_root": identity_result(bundle_id, bundle_preimage),
            "encrypted_container": identity_result(container_id, container_preimage),
        },
        "preimages": {
            "writer_signature": summary(writer_signature),
            "hpke_info_hex": info.hex(),
            "envelope_aad_hex": aad.hex(),
            "envelope_aad_sha256_hex": digest(aad).hex(),
            "sender_signature_preimage": summary(sender_signature),
        },
        "authority": {
            "classes": [
                "portable_authoritative", "device_private_authoritative", "device_private_operational",
                "local_transactional", "rebuildable", "staging", "materialized_projection", "encrypted_recovery",
            ],
            "authoritative_device_examples": ["device_private_authoritative"] * 8,
            "operational_device_examples": ["device_private_operational"] * 9,
        },
        "limits": {
            "profile_id": "patchmark/hc2/limits/v1",
            "profile_version": 1,
            "object_count": 1,
            "object_bytes": len(markdown),
            "ciphertext_bytes": len(ciphertext),
            "maximum_canonical_object_bytes": 16 * MIB,
            "maximum_total_object_bytes_per_chunk": 16 * MIB,
            "maximum_manifest_canonical_bytes": MIB,
            "maximum_chunk_payload_core_structural_overhead_bytes": 896 * KIB,
            "maximum_chunk_payload_core_canonical_bytes": 18 * MIB - 128 * KIB,
            "maximum_signed_plaintext_core_structural_overhead_bytes": 64 * KIB,
            "maximum_signed_plaintext_core_canonical_bytes": 18 * MIB - 64 * KIB,
            "maximum_signed_plaintext_record_structural_overhead_bytes": 64 * KIB,
            "maximum_signed_plaintext_record_canonical_bytes": MAXIMUM_SIGNED_RECORD_BYTES,
            "aes_256_gcm_authentication_tag_bytes": AES_256_GCM_TAG_BYTES,
            "maximum_aead_ciphertext_bytes": maximum_ciphertext,
            "maximum_public_header_canonical_bytes": 4 * KIB,
            "maximum_encrypted_container_framing_bytes": 60 * KIB - 16,
            "maximum_encrypted_container_canonical_bytes": MAXIMUM_CONTAINER_BYTES,
            "maximum_portable_bundle_canonical_bytes": MAXIMUM_BUNDLE_BYTES,
            "maximum_objects_per_chunk": 1024,
            "maximum_chunks_per_bundle": 4096,
            "maximum_dependency_depth": 256,
            "fixed_recovery_headroom_bytes": 64 * MIB,
            "maximum_supported_byte_count": 2**53 - 1,
            "maximum_bundle_array_fixture_count": len(maximum_bundle_lengths),
            "maximum_bundle_array_fixture_bytes": portable_bundle_length(maximum_bundle_lengths),
            "maximum_required_quota_bytes": 2 * MAXIMUM_BUNDLE_BYTES + 64 * MIB,
            "compression": "none",
        },
    }
    if actual != vectors["expected"]:
        raise AssertionError(
            "independent HC-2 vector mismatch\n"
            + json.dumps({"actual": actual, "expected": vectors["expected"]}, indent=2)
        )
    print(json.dumps({
        "independent_verifier": "python-standard-library-only",
        "canonical_cores": len(canonical_cores),
        "digest_identities": 8,
        "authority_classes": 8,
        "limit_boundaries": 14,
        "frozen_fixture": str(FIXTURE),
        "equivalent": True,
    }, indent=2))


if __name__ == "__main__":
    main()

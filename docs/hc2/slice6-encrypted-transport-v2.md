# HC-2 Slice 6: Encrypted transport profile v2

Status: implemented behind the disabled HC-2 collaboration boundary. This is a
transport profile, not a production feature enablement or a migration.

## Why a new version is required

The frozen v1 `SignedPlaintextCore` admits only an HC-1 `ChunkPayloadCore` and
does not bind the sender and recipient membership identities, accepted control
head, key epoch commitment, transport purpose, or stream continuity position.
Its HC-1 object-kind union also cannot carry Slice 5 admission, epoch-delivery,
or receipt evidence. Adding those fields or object kinds to v1 would change its
canonical bytes, signature preimages, HPKE AAD expectations, identities, and
frozen vectors. Slice 6 therefore uses an explicitly incompatible v2 transport
profile and leaves every v1 parser, encoder, domain, limit, and fixture intact.

V1 remains available only to its compatibility tests. Slice 6 export and import
accept v2 exclusively; v1, mixed-version, and unknown-version bundles fail
closed. No migration path is required while production collaboration remains
disabled.

## Public and encrypted boundaries

The v2 public header has exactly nine fields: magic, envelope version, suite,
X25519 encapsulated key, opaque envelope ID, opaque recipient routing tag,
ordinal, count, and ciphertext length. Project, object, person, membership,
device, control, epoch, purpose, and stream identifiers are never public.
Inbound continuity classification occurs only after successful HPKE open,
strict canonical decode, and Ed25519 verification, so rejected ciphertext does
not expose a semantic or replay oracle.

Every signed plaintext carries a `TransportBindingCoreV2`. It commits project,
purpose, sender and recipient identities and keys, accepted control head, epoch
identity and commitment, stream identity/generation/sequence/predecessor,
manifest identity, payload kind/ordinal/count, limit profile, and crypto suite.
The bundle manifest commits the common binding and a dense ordered descriptor
for every non-manifest payload. The manifest commitment excludes itself, which
removes the only self-reference in the derivation graph.

The derivation order is fixed: select non-manifest payloads; derive their
commitments; construct and commit the manifest; bind each payload; sign the
plaintext; create one fresh HPKE context; finalize the exact `enc` header; build
AAD; seal once; derive container identities; write the canonical array.

Before that derivation starts, a mandatory sender-side authority resolver must
accept the bound sender and recipient membership/device/key at the exact control
head and confirm current epoch custody. Rejection happens before randomness,
hashing, signing, or HPKE, so a revoked recipient cannot receive a newly created
replication ciphertext through the transport preparation API. Import repeats
the accepted-control, revocation, recipient, purpose, and epoch checks after
authenticated decryption; portable evidence never authorizes either side.

## Payload and storage separation

V2 has five first-class payloads: manifest, unchanged HC-1 object chunk,
admission attachment, epoch-delivery attachment, and receipt attachment. Slice
6 does not broaden the HC-1 `CollaborationObjectKind` or `ChunkPayloadCore`
unions. HC-2 evidence uses the dedicated
`.patchmark/patchmark-collaboration/v1/hc2-transport-v2/` attachment namespace,
with staging, immutable data, per-attachment commit markers, and one combined
batch marker written last. The combined marker names imported HC-1 object IDs
and HC-2 attachment IDs; no sidecar metadata is authoritative.

Admission installs the verified accepted-state transition and authenticated
epoch secret before the combined visibility marker. It records
`full_history_verified: false`. Reverse receipts travel as separately signed,
recipient-encrypted receipt attachments.

## Limits and memory

The frozen v1 numeric limits remain the v2 absolute ceilings: 18,939,904 bytes
per encrypted container, 268,435,456 bytes per canonical bundle, 4,096 payloads,
1,024 HC-1 objects per chunk, and dependency depth 256. Compression remains
forbidden. V2 wrapper and semantic-binding bytes must fit inside the already
reserved signed-plaintext headroom; the HC-1 chunk limit is not enlarged.

The enforced worst-case arithmetic is:

```text
18,743,296  maximum unchanged ChunkPayloadCore
+   65,536  maximum complete SignedPlaintextCoreV2 wrapper
=18,808,832  frozen signed-core maximum
+   65,536  maximum Ed25519 signed-record wrapper
=18,874,368  frozen signed-record maximum
+       16  AES-256-GCM authentication tag
=18,874,384  frozen ciphertext maximum
+    4,096  frozen opaque public-header maximum
+   61,424  frozen container framing maximum
=18,939,904  frozen encrypted-container maximum
```

The parsers measure the actual HC-1 v2 core and record wrappers separately and
pass them through the frozen Slice 1 budget calculators. The compact frozen
vector's two signed-core wrappers are 1,454 and 1,455 bytes; its record wrappers
are 172 bytes each. Thus the concrete schema remains far inside both 64 KiB
reservations while the maximum-case equations remain exact and executable.

The outer file is one canonical definite-length CBOR array. Writers and readers
process one container at a time, enforce limits before allocation, and use an
injected incremental SHA-256. An outbound CAS journal retains exact immutable
container bytes. A stream head advances only after the closed file reopens with
the same length, digest, ordered container IDs, and byte-identical records.

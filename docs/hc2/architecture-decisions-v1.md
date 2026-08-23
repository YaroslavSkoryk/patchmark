# HC-2 Architecture Decisions v1

Status: accepted for HC-2 Slice 1 contract work.

Scope: production-facing decisions that must be frozen before durable collaboration data or valuable keys exist. The thin vertical HC-2 milestone is two enrolled local devices exchanging a bounded encrypted portable bundle, atomically ingesting it, reconstructing the same accepted projection/checkpoint, and producing acknowledgements without a relay, background synchronization, or production collaboration UI.

## ADR-001 — HC-2 boundary and thin vertical milestone

- **Context:** Storage, custody, enrollment, and transport cannot be validated safely as unrelated production fragments.
- **Decision:** HC-2 targets one disabled, end-to-end portable-bundle exchange between two enrolled local devices. Slice 1 freezes contracts only.
- **Security rationale:** The milestone forces authority, custody, verification, and atomic-ingestion assumptions to meet before enablement.
- **Product consequences:** Existing single-user behavior remains unchanged. Collaboration remains unreachable in production through the final audit.
- **Rejected alternatives:** Storage-only or crypto-only production rollouts; live networking first; broad collaboration UI first.
- **Failure behavior:** Any incomplete capability leaves collaboration disabled or read-only.
- **Deferred work:** Live transports, relays, polished UI, background synchronization, and user-facing enablement.
- **Tests/later gates:** Slices 2–8 prove the vertical path; Slice 9 performs the read-only final audit.

## ADR-002 — Supported platform and capability policy

- **Context:** Ed25519 and X25519 availability, browser persistence, filesystem access, and coordination differ by runtime.
- **Decision:** Initial collaboration support is Chrome and Edge desktop, with an absolute Chromium floor of 137 and an actual qualified window of the current or previous two stable/Extended Stable releases. Runtime probes are mandatory.
- **Security rationale:** User-agent claims cannot prove usable algorithms, non-extractable key persistence, strict IndexedDB transactions, Web Locks, or filesystem access.
- **Product consequences:** A nominally supported release that fails a required probe cannot author collaboration state. A newer unqualified release remains unsupported.
- **Rejected alternatives:** Chromium 120; version checks alone; all-browser best effort.
- **Failure behavior:** Unsupported platform, private context, unknown version, unqualified window, or required-probe failure fails closed. A verified folder may remain read-only where safe.
- **Deferred work:** Wider browser support and future qualified release updates.
- **Tests/later gates:** Slice 1 pure policy vectors; Slice 2 storage probes; Slice 3 cryptographic matrix; Slice 8 complete Chrome/Edge matrix.

## ADR-003 — Portable-folder authority and state classification

- **Context:** A user-selected project folder must remain a complete durable portable replica.
- **Decision:** Immutable collaboration objects, verified commit markers, replica metadata, and committed recovery-recipient envelopes are `portable_authoritative`: authoritative persisted project evidence, not permission to act. Device-private state is split structurally. Non-extractable person/device key handles, device KEKs, wrapped epochs, stream generation/high-water, exact pending-reservation/CAS continuity, and inseparable security metadata are `device_private_authoritative` only for local cryptographic or sequence safety. The pending transaction intent itself remains `local_transactional`. Folder/file handles, permissions, paths/bindings, bookmarks, editor/focus/selection/draft/review/UI state, aliases, diagnostics, capability observations, storage estimates, and persistence observations are `device_private_operational` only.
- **Security rationale:** Browser-site-data loss must not destroy project history, while copying a folder must not copy private authority. Operational state can permit or block a local action but can never validate project identity, membership, authorship, control, portable objects, checkpoints, revisions, conflicts, or projection roots. Device-private authoritative state cannot override accepted portable control events or immutable project objects.
- **Product consequences:** A copied folder can be verified and reconstructed. With the recovery kit, it can recover under a newly enrolled device identity. Losing operational state affects availability or UX only. Losing authoritative device-private continuity blocks safe authoring or requires a new device identity.

| Classification | Frozen meaning |
| --- | --- |
| `portable_authoritative` | Persisted project evidence required to verify/reconstruct state; never an independent permission grant |
| `device_private_authoritative` | Local non-extractable key or exact sequence-continuity integrity required for safe authoring; cannot override portable control state |
| `device_private_operational` | Local availability, selection, observation, diagnostic, or UX state with no project, identity, authorship, sequence, conflict, revision, checkpoint, or projection authority |
| `local_transactional` | Pending intent, journal, reservation, or writer-lock state used only to complete/repair an atomic local operation |
| `rebuildable` | Index or cache derivable from authoritative inputs |
| `staging` | Invisible pre-commit data |
| `materialized_projection` | Non-authoritative rendered/projected output and status |
| `encrypted_recovery` | External encrypted recovery artifact, usable only through recovery policy and verification |

- **Rejected alternatives:** OPFS/IndexedDB-only authority; folder containing only `document.md` and a pointer; automatically exported secondary archive authority.
- **Failure behavior:** Missing/corrupt portable dependencies make the affected batch invisible, never partially visible.
- **Deferred work:** Production folder adapter and reconstruction implementation.
- **Tests/later gates:** Exhaustive runtime and type-level classification tests, exact fail-closed parsers, address tests, folder-only rebuild and incomplete-copy tests in Slice 2.

## ADR-004 — IndexedDB CAS and key-vault responsibilities

- **Context:** Same-profile tabs require transactional sequence allocation and non-extractable keys require origin-private custody.
- **Decision:** IndexedDB owns the device key-vault boundary, stream generation/high-water, exact pending reservations, cross-tab CAS state, and rebuildable local catalogs. Reservation/high-water state is colocated with device-key continuity.
- **Security rationale:** One strict transaction can prevent same-device sequence reuse and conflicting pending replacement without making IndexedDB semantic project authority.
- **Product consequences:** Identical pending retries are idempotent; different replacements fail. A committed folder batch repairs lagging local bookkeeping.
- **Rejected alternatives:** Filesystem-only sequence allocation; in-memory locks; treating an IndexedDB catalog as project truth.
- **Failure behavior:** IndexedDB ahead of the folder marker blocks new authoring until the exact reservation is recovered. Ambiguous key/CAS continuity requires a new device identity.
- **Deferred work:** Actual database schema, transactions, migrations, Web Lock acquisition, and repair execution.
- **Tests/later gates:** Pure CAS transition tests in Slice 1; transactional/crash/concurrency tests in Slice 2.

## ADR-005 — OPFS disposable-cache policy

- **Context:** OPFS can improve staging and lookup performance but is origin-private and may be removed.
- **Decision:** OPFS is optional disposable staging/cache only. It is never semantic authority and is not required to open, verify, rebuild, or recover a project.
- **Security rationale:** Clearing browser data must not destroy authoritative history or create an unobservable split authority.
- **Product consequences:** OPFS can be disabled under quota pressure. Its loss requires no semantic recovery.
- **Rejected alternatives:** OPFS object authority; automatic restoration from OPFS without explicit verification.
- **Failure behavior:** Missing OPFS data is a cache miss. Any offered forensic recovery evidence follows normal object verification and explicit user flow.
- **Deferred work:** Cache implementation and performance policy.
- **Tests/later gates:** Slice 2 clears OPFS independently and proves a complete folder rebuild.

## ADR-006 — Persistence denial and read-only behavior

- **Context:** `navigator.storage.persist()` can be denied even when the selected folder remains durable and writable.
- **Decision:** Denial does not automatically block authoring. A writable verified folder, valid recovery kit, operational strict coordination, and passed probes permit authoring with a durability warning.
- **Security rationale:** Device-private state may be evicted, but the portable graph survives and recovery creates a new device rather than losing the project.
- **Product consequences:** Persistence denial reduces device-identity durability, not project ownership. Private/incognito remains unsupported.
- **Rejected alternatives:** Blanket write denial; claiming best-effort storage is either immediately unsafe or non-evictable.
- **Failure behavior:** Missing write permission yields verified read-only; low quota disables cache and becomes read-only if a minimal strict reservation cannot commit.
- **Deferred work:** UI wording and live storage observation.
- **Tests/later gates:** Slice 1 readiness vectors; Slice 2 quota, permission, and persistence-denial behavior.

## ADR-007 — Plaintext-at-rest disclosure

- **Context:** HC-2 does not introduce an encrypted-at-rest project vault.
- **Decision:** Collaboration history in the selected folder remains plaintext, with a versioned disclosure before enablement.
- **Security rationale:** The design must not imply that a recovery password controls previously readable folder content.
- **Product consequences:** Anyone with the copied folder can read its plaintext history. The recovery kit controls owner recovery and future authority, not folder confidentiality.
- **Rejected alternatives:** Implicit confidentiality claims; mixing an unfinished encrypted-at-rest vault into HC-2.
- **Failure behavior:** Missing disclosure acceptance blocks collaboration enablement, not existing single-user use.
- **Deferred work:** Encrypted-at-rest vault and revocation-resistant local confidentiality.
- **Tests/later gates:** Replica metadata binds the disclosure version; enablement behavior is tested in later integration slices.

## ADR-008 — Mandatory recovery-kit policy

- **Context:** Browser-private storage can be deleted and non-extractable device keys cannot be exported as backups.
- **Decision:** A valid separately held recovery kit is mandatory before collaboration enablement.
- **Security rationale:** Folder survival must permit owner-authorized new-device enrollment without recreating an old device or storing raw root/epoch secrets in the folder.
- **Product consequences:** A folder without the kit remains readable and verifiable but cannot regain owner authority after device loss.
- **Rejected alternatives:** Optional recovery; raw private keys in the project folder; silently recreating the old identity.
- **Failure behavior:** Missing/invalid kit blocks enablement or recovery. Lost kit plus loss of all owner devices is unrecoverable.
- **Deferred work:** Argon2id/XChaCha20-Poly1305 execution and recovery ceremony.
- **Tests/later gates:** Slice 4 proves folder-only recovery, wrong-password behavior, and new-device enrollment.

## ADR-009 — Person, device, root, and epoch custody boundaries

- **Context:** Signing, recipient, root, KEK, and epoch material have different authority and ceremony scopes.
- **Decision:** Long-lived private keys are opaque non-extractable native handles in the device vault. Root and recovery ceremonies use separate narrowly scoped capabilities. Raw epoch secrets never enter the folder; only recipient-bound encrypted envelopes do.
- **Security rationale:** Separate capabilities minimize accidental use and prevent generic private-key serialization APIs.
- **Product consequences:** Browser-state loss retires the old device. Recovery enrolls a new device and installs new local wraps.
- **Rejected alternatives:** Exportable long-lived recipient keys; generic key import/export; shared root/device handle type.
- **Failure behavior:** Missing or ambiguous handles block the old identity and require recovery.
- **Deferred work:** Key generation, persistence, destruction, epoch wrapping, and ceremonies.
- **Tests/later gates:** Slice 1 compile-time separation; Slice 3 provider proof; Slice 4 custody/recovery tests.

## ADR-010 — Provider-independent cryptographic architecture

- **Context:** Protocol contracts must not freeze a package-specific raw-key representation.
- **Decision:** Freeze exact v1 algorithms and opaque interfaces for randomness, signatures, recipient envelopes, recovery protection, key vault, public-key codec, suite negotiation, and accepted-control signer resolution.
- **Security rationale:** Callers cannot request nonces, reusable HPKE contexts, provider key generation, generic private export, or trust an inline asserted sender key.
- **Product consequences:** Providers are replaceable behind exact suite and custody contracts. Returned/accepted byte arrays must be copied.
- **Rejected alternatives:** Package types in shared contracts; boolean verification; self-asserted sender keys; silent algorithm substitution.
- **Failure behavior:** Unknown/partial suite support and unresolved signer authority fail closed.
- **Deferred work:** Provider implementations and package choice.
- **Tests/later gates:** Type tests in Slice 1; RFC/negative/provider vectors in Slice 3.

## ADR-011 — HPKE provider approval deferral

- **Context:** Native non-extractable X25519 compatibility is possible, but provider audit, provenance, and minimum-browser evidence are not yet complete.
- **Decision:** Slice 1 freezes native non-extractable X25519 handles and a single-shot RFC 9180 interface, not a package. Provider approval is a Slice 3 exit gate.
- **Security rationale:** A compatible current implementation is insufficient proof for the supported matrix or production security claim.
- **Product consequences:** No HPKE dependency or lockfile change occurs in Slice 1.
- **Rejected alternatives:** Freezing `@hpke/dhkem-x25519` raw-key representation; using provider key generation; approving from marketing claims.
- **Failure behavior:** Any provider requiring extractable recipient secrets, raw serialization, reusable contexts, or nonce control is rejected.
- **Deferred work:** Independent source review, advisory/provenance review, pinned versions, RFC vectors, and browser matrix.
- **Tests/later gates:** Slice 3 cannot exit until every provider/custody requirement passes.

Slice 3 selected exact `@hpke/core@1.9.0` and `@hpke/common@1.10.1` artifacts after source, provenance, advisory, vector, and browser review. The public contract remains provider-independent: the selected implementation and its operation context are private implementation details. “Single-shot” describes one public call and one-message context lifetime; it does not require AAD to exist before HPKE sender setup.

## ADR-012 — Non-circular encrypted-envelope model and bound HPKE ordering

- **Context:** Signatures, ciphertext, bundle roots, and container IDs can become circular if their cores include values derived later.
- **Decision:** Derive chunk commitments, then the ordered bundle root and signed plaintext core. HPKE `info` is deterministic, versioned, suite-specific, and independent of `enc`. For each encryption, perform RFC 9180 sender setup once to obtain the exact `enc` and a private operation-local context; synchronously construct the exact-field final header containing that `enc`; canonically encode the complete final header as AAD; seal exactly once; discard the context; and derive the container ID last outside its core. Sender signatures continue to bind the digest of the same final canonical header plus the plaintext core.
- **Security rationale:** The signature never includes itself; HPKE `info` excludes `enc`, ciphertext, and container ID; setup is never repeated; no placeholder `enc` exists; and the final header, including the setup-produced `enc`, is authenticated as AAD.
- **Product consequences:** Re-encryption creates a new container ID without changing HC-1 identities. Headers expose only minimal routing and cryptographic fields.
- **Rejected alternatives:** Signature inside its preimage; container ID inside its core; plaintext project/object identifiers in the public header; best-effort unknown-version parsing; placeholder or hashed-placeholder encapsulations; two sender setups; caller-supplied independent AAD/`enc`; or an exposed reusable HPKE context.
- **Failure behavior:** Mutation, substitution, deletion, duplication, reordering, and cross-bundle movement are rejected before local batch visibility.
- **Deferred work:** Higher-level enrollment, export/import, and ingestion orchestration.
- **Tests/later gates:** Frozen Node/Python/Chrome vectors in Slice 1; real cryptographic, exact-`enc` binding, single-use, and import vectors in Slice 3; complete exchange vectors in Slice 6.

## ADR-013 — Project-wide current-state onboarding

- **Context:** Full-history verification and fine-grained document access add protocol scope beyond the first milestone.
- **Decision:** Initial admission grants project-wide current-state access at an owner-authorized boundary.
- **Security rationale:** The admitted boundary and accepted control state explicitly define authority without pretending older history was fully verified.
- **Product consequences:** New members receive the current project scope, not per-document grants.
- **Rejected alternatives:** Fine-grained document grants in HC-2; mandatory full-history onboarding.
- **Failure behavior:** Missing owner authorization or boundary verification blocks admission.
- **Deferred work:** Full-history onboarding and fine-grained access.
- **Tests/later gates:** Slice 5 enrollment tests and Slice 8 two-device harness.

## ADR-014 — No background work or live networking

- **Context:** Background retries, watchers, and networking expand concurrency and lifecycle risk before local correctness is proven.
- **Decision:** HC-2 uses explicit foreground operations and a bounded two-way portable bundle. No timers, watchers, workers, retries, network requests, relay, or background synchronization are introduced by Slice 1.
- **Security rationale:** User-mediated operations keep authority and failure boundaries observable and testable.
- **Product consequences:** Devices do not synchronize automatically.
- **Rejected alternatives:** Service-worker sync; live peer transport; relay-first deployment.
- **Failure behavior:** Interrupted foreground work remains staged/invisible and resumes only through explicit recovery.
- **Deferred work:** Direct transport, relay design, and background processing.
- **Tests/later gates:** Import-safety and production-unreachability tests now; future transport work belongs to HC-3 or later.

## ADR-015 — Explicit HC-3 and later deferrals

- **Context:** Several desirable features are not dependencies of the HC-2 portable-bundle milestone.
- **Decision:** Defer live networking, relay deployment, background sync, polished collaboration UI, fine-grained document access, full-history onboarding, encrypted-at-rest vaults, pruning, and garbage collection.
- **Security rationale:** Deferral prevents unaudited features from changing authority, retention, confidentiality, or concurrency assumptions.
- **Product consequences:** HC-2 remains a bounded disabled technical milestone.
- **Rejected alternatives:** Expanding HC-2 whenever a later feature appears adjacent.
- **Failure behavior:** No deferred feature may be inferred from a Slice 1 contract or enabled through configuration.
- **Deferred work:** The listed features require separately scoped ADRs and milestones.
- **Tests/later gates:** Production-shadow lock and import scans must continue to prove absence and unreachability.

## Frozen protocol limits

The `patchmark/hc2/limits/v1` profile freezes distinct byte boundaries:

| Boundary | Limit | Exact measurement |
| --- | ---: | --- |
| Individual object | 16 MiB | Canonical object bytes |
| Objects carried by one chunk | 16 MiB | Sum of exact object byte strings |
| Manifest | 1 MiB | Canonical CBOR of the complete manifest array |
| `ChunkPayloadCore` | 18 MiB − 128 KiB | Canonical CBOR of the complete core |
| `SignedPlaintextCore` | 18 MiB − 64 KiB | Canonical CBOR of the complete core |
| `SignedPlaintextRecord` | 18 MiB | Canonical CBOR passed as HPKE plaintext |
| AES-256-GCM ciphertext | 18 MiB + 16 bytes | Exact plaintext-record length plus the fixed 16-byte tag |
| Public header | 4 KiB | Canonical CBOR of the complete header/AAD, including the encapsulated key |
| Encrypted-container framing | 60 KiB − 16 bytes | Container map/key and CBOR structural allowance outside ciphertext/header |
| `EncryptedContainerCore` | 18 MiB + 64 KiB | Canonical CBOR of the complete header and ciphertext container |
| Portable bundle | 256 MiB | Exact canonical array framing plus transferred encrypted-container records |

The chunk-core maximum sits 128 KiB below the final signed-record maximum: 64 KiB is reserved for the signed-core wrapper and 64 KiB for the signature-record wrapper. The 18 MiB record budget leaves more than 1 MiB above the 16 MiB object payload for a 1 MiB manifest and bounded canonical metadata. The encrypted-container identity continues to commit to the exact final canonical container core. The complete logical bundle root remains independent of envelope IDs and ciphertext randomness.

The count limits remain 1,024 objects per chunk, 4,096 chunks per bundle, and dependency depth 256. Compression remains prohibited. Validators preflight declared and actual byte lengths, then recheck canonical encodings, ciphertext formula, complete container, and aggregate bundle framing. Independently valid maxima that do not fit together fail with their specific enclosing-layer reason before further copying or allocation.

Quota is `2 × bounded_operation_bytes + 64 MiB`; a maximum 256 MiB bundle therefore requires 576 MiB. All arithmetic uses checked `bigint`, rejects unsafe inputs and unsupported profiles/suites, and is bounded to the supported safe byte-count range.

# HC-2 Slice 8 disabled workflow qualification

Status: qualification-only. Production collaboration remains unconditionally
disabled. This is not product UI, migration, network sync, or enablement.

## Integration boundary

`qualification-workflow.ts` is an environment-neutral facade. It owns no
folder, database, lock, OPFS, key, random source, worker, projector, membership
model, transport, or authority. The caller injects a durable evidence reader
and an operation port backed by existing HC-1/HC-2 implementations. Each method
invokes exactly one bounded operation, returns frozen evidence, and schedules no
retry or continuation.

The 21 actions cover readiness, foundation, recovery-kit verification,
invitation, enrollment, V2 admission, V3 synchronization, HC-1 semantic work
and conflict resolution, revocation, root recovery, and durable reopen. Status
guidance has `authority: "none"`. Forked, corrupt, ambiguous, or permanently
quarantined evidence is blocked without choosing or resetting a winner.

## Source boundary

The single-user project is immutable source evidence. Qualification captures
its exact byte snapshot and compares its SHA-256 before and after every
successful or failed action. Foundation uses the native HC-1 duplication
boundary and a fresh destination. Paths, handles, editor/bookmark/recovery
state, diagnostics, URLs, and external candidates are excluded. Current state
is one authenticated import boundary; historical authorship is not fabricated.

## Manual two-profile runbook

Use a current Chromium browser with WebCrypto Ed25519/X25519, IndexedDB, Web
Locks, workers, and a secure context. Use disposable isolated profiles. The
automated harness uses localhost only to serve test modules; artifact exchange
performs no network request.

1. Capture source bytes and private-state sentinels. Select a new empty
   destination for A. Expect `foundation_plan_required`.
2. Explicitly plan and execute foundation creation. Select a separate recovery
   destination and provide the test password through the interaction boundary.
   Reopen, decrypt, and verify the kit. Expect `invitation_handoff_required`.
3. A creates an owner-authorized invitation. Move only its artifact to B.
4. B creates fresh non-extractable signing/recipient keys and returns the
   signed request. A creates an HPKE challenge; B proves both keys; A verifies
   and approves the exact request.
5. A rotates the epoch, completes every delivery, and exports V2 admission.
   Move the exact encrypted file to B. B imports atomically, installs the epoch,
   and returns receipt/acknowledgement evidence. B retains
   `full_history_verified: false`.
6. Offline, both devices create accepted work without observing each other,
   including concurrent project-title values.
7. Explicitly request V3 inventory/request/response files and move each opaque
   file manually. Continue only when returned guidance identifies another
   bounded action. Qualification uses intentionally small page/request caps.
8. Stop after any call, close the profile, and reopen. Resume the exact journal
   and retry exact bytes. Duplicates are idempotent; gaps await predecessors;
   wrong-recipient, corrupt, stale, or forked files stay rejected/blocked.
9. An owner/editor resolves the exact observed contender set through HC-1. A
   reviewer is insufficient. Exchange the resolution via V3 and reopen both
   replicas to verify identical resolved state and no discarded unseen work.
10. A revokes B and rotates the epoch without a delivery to B. B cannot append
    accepted post-cutoff work, export fresh authorized synchronization, or open
    replacement-epoch ciphertext. Already-held plaintext/ciphertext cannot be
    recalled.
11. Delete A's browser profile while preserving only the portable destination
    and verified kit. In a fresh profile, use root recovery with a new device ID
    and keys, supersede the lost device, and create a replacement epoch. Restore
    no old key, sequence, reservation, path, or UI state.
12. Reopen durable portable/IndexedDB state and compare the complete equality
    matrix. Expect `converged`.

Filenames and paths are operational labels only. The manual adapter preserves
opaque bytes and can inject truncation, corruption, duplication, replacement,
and permission failures without decrypting. It does not model future network
transport.

To clean up, close tabs/profiles and delete disposable profiles, qualification
projects, recovery kits, artifacts, and test databases. Remove `.next`,
TypeScript/Python caches, and random reports. Never put passwords, keys,
personal paths, source content, or random identities in a report.

The deterministic summary template contains only versions, results, counts,
commitments, fixture hashes, idle counters, isolation results, and limitations.
V1, V2, and V3 stay frozen. Slice 8 adds no wire field, parser acceptance,
suite, version, migration, route, flag, endpoint, watcher, timer, or worker.

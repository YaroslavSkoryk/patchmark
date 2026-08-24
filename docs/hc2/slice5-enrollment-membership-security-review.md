# HC-2 Slice 5 enrollment, membership, and epoch security review

Status: test-only protocol implementation. Production collaboration remains unconditionally disabled. Encrypted portable transfer, synchronization, and production UI are deferred.

## Trust and authority boundary

An invitation is an owner-authored control action, but possession of its identifier or authority-free handoff proves neither a real-world identity nor membership. The handoff references accepted invitation evidence and carries no owner private material, epoch secret, folder state, or authority. The owner's explicit acceptance is the out-of-band identity decision; the protocol cannot independently determine who a human is or whether an additional device belongs to that human.

Enrollment request, challenge, possession proof, delivery, admission, and receipt records all have `authority: "none"`. They can prove bindings and key possession, but cannot authorize themselves. Only an accepted HC-1 control action/event issued by the designated active control device for an accepted owner changes membership, device, role, revocation, or epoch authority. Editor and reviewer artifacts never cross that boundary, and requested roles are never promoted implicitly.

## Invitation and enrollment lifecycle

Invitation validity is deterministic and control-sequence based, not wall-clock based. Creation binds the project, inviting owner membership/person/device, intended role, project-wide scope, accepted creation head, and the last valid control sequence. Cancellation and consumption use IndexedDB compare-and-swap against the accepted state. An invitation becomes terminal once cancelled or consumed; competing consumers cannot create two accepted membership results.

The candidate creates a new device ID and non-extractable Ed25519, X25519, and AES-GCM local-wrapping keys in Slice 4 custody. The exact-field enrollment request binds both canonical public keys and key IDs, the invitation evidence, requested or existing person/membership, device, project-wide role/scope, accepted control head, nonce, and suite. Its domain-separated Ed25519 signature proves signing-key possession only.

X25519 possession is separate. The owner validates the request signature, creates a fresh challenge bound to the request and both public-key digests, authenticates the complete public header as HPKE AAD, and seals to the candidate key. The candidate must reopen its persisted X25519 key, decrypt the challenge, derive the exact response, and sign the response identity with its Ed25519 key. The local challenge is one-use and becomes invalid when consumed or when the bound control head changes. Successful proof remains authority-free until owner approval.

## Membership and device state machine

The accepted state has sorted membership and device facts. Supported mutations are new membership, additional device, role change, device revocation, and membership revocation. Every transition requires the exact current head and next sequence, the designated active control device, accepted owner capabilities, fresh non-reassigned identities and public-key bytes, project-wide scope, and at least one remaining owner. Additional-device approval explicitly assigns the new device to an existing accepted membership; it is not independent human-identity proof.

The offline root cannot be removed through ordinary membership transitions. Revoking the designated control device requires an exact active replacement in the same transition. Membership revocation revokes all of its active devices with explicit semantic-sequence cutoffs. Device facts remain visible after revocation so late authority checks fail deterministically.

## Mandatory epoch rotation and recipients

Every accepted membership, device-authority, role, revocation, or associated control-device change creates a fresh 32-byte epoch secret, new epoch identity, and public commitment. The prior epoch cannot be reused. The recipient manifest is derived exclusively from the accepted post-transition state and is sorted by device ID. It includes every active project-wide device, including offline devices, and excludes every revoked membership/device. Network presence never elects, omits, or delays authority.

The authorizing device wraps the new epoch immediately under its non-extractable local KEK. Plaintext is wiped after bounded callbacks and is not stored in invitation, request, challenge, proof, control, admission, receipt, portable, or journal records.

## Non-circular delivery derivation order

The exact order is:

1. Validate the prior accepted control and membership state plus owner authority.
2. Generate the fresh epoch secret and derive its public commitment.
3. Apply the proposed authority mutation in memory.
4. Derive the exact sorted post-state recipient manifest.
5. Derive the delivery-set core from the manifest, epoch, and prior control head.
6. Derive the resulting control-state root.
7. Derive the membership-transition identity, then the HC-1 control action identity.
8. Derive and accept the HC-1 control event, which commits to the transition, manifest, delivery set, epoch commitment, and resulting control state.
9. Create one fresh HPKE context per recipient. Each delivery header binds the already-derived accepted control event ID, transition, delivery set, manifest, epoch, recipient person/device/key and ordinal.
10. Verify the complete envelope set before publishing the batch marker.

Ciphertext identities therefore depend on the accepted event, but the event never depends on ciphertext identities. Missing, duplicate, substituted, or extra recipient envelopes fail closed.

## Crash safety and visibility

Web Locks provide advisory same-profile exclusion; IndexedDB compare-and-swap is authoritative. The sender journals the immutable wrapped epoch and each completed delivery's exact canonical bytes and identity. An exact retry resumes the same ceremony plan, reconstructs the same wrapped epoch, retains already journaled envelopes, and creates only missing envelopes. A conflicting plan, wrapped epoch, control head, manifest, delivery, vault, or completion record fails closed. HPKE contexts and AES-GCM nonces are never reused.

The ordered phases are `planned`, `control_reserved`, `epoch_wrapped`, `delivery_partial`, `delivery_complete`, `control_committed`, `batch_visible`, `indexeddb_finalized`, `reopen_verified`, `admission_ready`, and `complete`. Immutable data and attestations precede the complete batch marker; reconstructed acceptance and vault reopen precede the local completion marker. No hashing, signing, HPKE, filesystem, or worker operation runs inside an IndexedDB transaction. There are no timers, polling, watchers, background workers, or automatic retries.

## Admission and acknowledgement honesty

The current-state admission package is authenticated by the accepted owner and verifies real HC-1 checkpoint, state-blob, snapshot, projection/component roots, frontier/manifests, reducer version, admission boundary, accepted authority, candidate key bindings, and the candidate's unique delivery envelope. It intentionally declares `full_history_verified: false`: the new device has not verified unavailable pre-admission history and receives no prior epoch secret.

After verification, the candidate opens its recipient envelope once, verifies the epoch commitment, wraps the secret under its local KEK, reopens and self-tests the installed vault, initializes its own receipt sequence at zero, signs the exact receipt identity, commits the receipt, and writes the admission-completion marker last. A receipt proves installed delivery and admission bindings; it grants no authority, chooses no fork, and compacts no history. Identical receipts are idempotent; conflicting same-device sequence records remain explicit forks.

## Revocation limitations

Revoked devices are excluded from the replacement-epoch manifest and cannot authenticate or decrypt another recipient's replacement envelope. Later events fail the accepted authority/cutoff checks, and one device cannot sign as another device. Revocation is not retroactive secrecy: it cannot erase plaintext, old epoch keys, exports, or a project folder already held by another person, and it cannot remotely delete physical copies. It protects future accepted authority and cryptographic exchanges.

## Secret inventory

Secret-bearing state is limited to non-extractable browser key handles, the candidate pending vault, the installed device vault, wrapped epoch ciphertext, short-lived challenge plaintext, and bounded in-memory epoch callbacks. Offline root seeds remain inside the existing root-recovery worker boundary. Canonical/portable authority excludes passwords, root seeds, private keys, KEKs, plaintext epochs, paths and handles, permission observations, browser/profile identifiers, diagnostics, UI state, locks, and journals. Frozen vectors use only published deterministic test material.

## Evidence and remaining limits

The compact frozen fixture is reproduced by Patchmark in Node and Chrome and independently in Python without Patchmark or third-party Python imports. The Python verifier implements canonical CBOR, SHA-256/Base32 identities, RFC 8032 Ed25519 verification, RFC 7748 X25519, RFC 9180 HPKE labeled HKDF, and AES-256-GCM. Chrome evidence uses separate temporary owner/candidate user-data directories, persistent non-extractable keys, two owner tabs, IndexedDB CAS, challenge reopen, epoch installation/reopen, final-marker ordering, and revoked-device replacement-open rejection.

Chrome evidence does not establish Edge behavior or infer a general Chromium compatibility floor from one Chrome build. Existing fixed dependencies are reused; no dependency or lockfile changes are required. Encrypted portable bundles, transport, synchronization, relays, production UI, identity providers, selective document/group encryption, background delivery, retroactive secrecy, and production enablement remain deferred.

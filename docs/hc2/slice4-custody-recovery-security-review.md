# HC-2 Slice 4 custody and recovery security review

Status: implementation evidence for a production-disabled custody boundary. Slice 4 does not authorize production reachability, enrollment, transport, synchronization, or UI enablement.

## Security boundary

Slice 4 replaces generic root-key persistence and generic root signing with two deliberately separate facilities:

- a versioned, explicit IndexedDB device vault containing native non-extractable Ed25519, X25519, and AES-256-GCM keys plus one AES-GCM-wrapped current epoch; and
- a user-supplied recovery-kit sink containing the only persistent representation of the offline project-root seed, encrypted under Argon2id and XChaCha20-Poly1305.

The HC-2 barrel exports the bounded root-ceremony provider, but not its worker protocol, root payload codec, worker implementation, or generic native-key registry. The production collaboration barrel still exports no HC-2 module, and application/component code still imports none. IndexedDB, workers, Web Locks, and recovery sinks are opened or invoked only through explicit calls.

## Secret inventory and storage

| Material | Persistent location | Protection and permitted use |
| --- | --- | --- |
| Device Ed25519 private key | Dedicated custody IndexedDB | Native `CryptoKey`, `extractable === false`, usages `sign`; only bounded device attestation signing. |
| Device X25519 private key | Dedicated custody IndexedDB | Native `CryptoKey`, `extractable === false`, usage `deriveBits`; only bounded HPKE recipient operation. |
| Device AES-256-GCM KEK | Dedicated custody IndexedDB | Native `CryptoKey`, `extractable === false`, usages `encrypt,decrypt`; only current-epoch wrap/unwrap. |
| Current 32-byte epoch secret | Never stored plaintext | AES-256-GCM ciphertext with a fresh 12-byte nonce and 16-byte tag; canonical AAD binds project, epoch, device, commitment, and KEK generation. Plaintext is exposed only to a bounded callback and then overwritten best-effort. |
| Offline 32-byte root seed | Encrypted recovery-kit payload only | Created and opened only inside a fresh root worker; Argon2id v19, operations limit 3, 64 MiB, parallelism 1, then XChaCha20-Poly1305. It is not a persistent `CryptoKey` and never enters IndexedDB or portable replica objects. |
| Recovery password material | Caller memory and one fresh worker operation | Copied into the bounded provider, transferred to the worker, overwritten best-effort in both contexts, and never persisted by Patchmark. The caller remains responsible for its own input buffer. |
| Recovery derived key, decrypted payload, seed-derived private key | Fresh root worker only | Created per create/verify/sign operation, overwritten with `sodium.memzero` in `finally`, and followed by unconditional worker termination. |
| Public keys, IDs, commitments, kit digest, control head, journal and completion marker | IndexedDB and/or portable objects | Non-secret authority and continuity evidence. The completion marker contains no private key, epoch secret, password, or decrypted root material and is excluded from portable replica data. |

The custody database has a frozen version-1 schema with separate stores for ceremony journals, device vaults, wrapped epochs, wrapping-nonce reservations, and completion markers. There is no legacy-store adoption or migration path. Reopen validation checks the exact record shape, suite and schema, project/person/device/scope binding, generations, public-key bytes and IDs, accepted control head, root and epoch references, algorithms, usages, extractability, and live Ed25519/X25519/AES self-tests. A stored record is not trusted merely because IndexedDB can deserialize its `CryptoKey` values.

## Recovery-kit format and offline root

The recovery kit is a strict, versioned, canonical CBOR container bounded at 64 KiB. Its authenticated public header includes the exact profile and suite, Argon2 parameters, AEAD, salt, nonce, encrypted length, project, root-key ID, tagged root public bytes, and root generation. The encrypted payload repeats and binds the project, root identity, root public bytes, generation, suite/profile, and seed. Unknown, missing, duplicate, non-canonical, oversized, cross-project, cross-root, wrong-password, authentication, and payload/header mismatch cases collapse to the public `recovery_failed` result.

Root creation, verification, and signing each use a fresh worker. Verification decrypts the kit, derives the root public key again, signs a kit-bound challenge in the worker, and verifies that signature independently with main-context WebCrypto. Signing accepts only runtime-branded initial-foundation or HC-1 root-recovery control preimages. The worker independently reconstructs the exact HC-1 control-event signature preimage from the project and control-event ID and rejects arbitrary messages. Main-context WebCrypto verifies every returned root signature.

JavaScript and WebAssembly wiping is best-effort: engines may retain copies in garbage-collected, structured-clone, JIT, or native memory, and Patchmark cannot prove erasure. Fresh-worker isolation, transfer of request copies, `finally` wiping, and termination reduce lifetime and accidental reuse; they do not create hardware-backed zeroization.

## Ceremony ordering, coordination, and crash behavior

The authoritative journal phases are `planned -> kit_verified -> keys_installed -> portable_visible -> complete`. Initial foundation validates the source and frozen plan before any visible collaboration object. It then:

1. acquires the project-wide custody Web Lock and creates or resumes an exact plan through IndexedDB CAS;
2. creates the root in a fresh worker when required, writes the recovery kit to the mandatory user sink, reads back exact bytes, decrypts it, performs the challenge, and independently verifies the root;
3. generates and self-tests the device keys and epoch outside the IndexedDB transaction;
4. binds the resulting real HC-1 genesis/control identity and atomically installs the vault, wrapped epoch, nonce reservation, and `keys_installed` journal transition;
5. obtains the bounded root authority signature and device attestation, commits portable objects, reopens and verifies accepted authority; and
6. writes the local, non-portable completion marker last.

Web Locks are advisory. All authoritative transitions use strict IndexedDB compare-and-swap, and custody install is one short transaction. Every project ceremony contends on one project lock even if competing plans propose different replacement devices. A different plan, kit digest, root, accepted control object, vault binding, epoch, or nonce cannot win an exact retry. AES-GCM nonce collision fails closed without a hidden retry.

Pre-install `planned` or `kit_verified` journals may be explicitly abandoned without publishing collaboration authority. Kit verification is durably recorded before key generation; the accepted control identity is added only to the ephemeral install input and becomes durable atomically with the vault, wrapped epoch, nonce reservation, and `keys_installed` phase. Once custody has been installed, `keys_installed` is conservatively non-abandonable because a crash could have occurred after an idempotent portable commit but before the local phase advance; exact resume is mandatory. Such a retry replays only the exact commit and cannot substitute a new root, kit, key binding, or control object. Once accepted control is portable-visible, root replacement or abandonment is also prohibited. Focused tests reach every declared ceremony failure cut, resume each exact plan, reject wrong-kit and replacement-root resumes, cover sink permission loss, and prove an injected partial IndexedDB vault transaction leaves no vault or epoch and preserves the pre-install journal.

## Profile-loss recovery

Recovery starts in a genuinely separate browser profile with no custody database. Before the kit is opened, the portable replica must verify as complete batches and resolve to one accepted HC-1 root state. The verified kit must match that accepted offline-root public key and generation. Recovery always allocates a brand-new device identity, Ed25519 key, X25519 key, KEK, and epoch; it does not restore the lost device's private keys, sequence continuity, or reservations.

The resulting real HC-1 `root_recovery` action binds the last uncontested control ID, prior root control, observed conflicting tips, selected membership/device state, revocation sequence cutoffs, replacement device, and replacement epoch. The offline root signs the exact typed control object. Reopen evidence must prove the replacement device authoritative and the lost device superseded. Later ordinary objects from the lost device resolve as `superseded_control_branch`, not as a competing winner.

Real Chrome 151 evidence uses two independently launched user-data directories. Profile A proves native non-extractable keys survive real IndexedDB structured clone and reopen, wrapped-epoch callback wiping, fresh root-worker termination, and same-profile two-tab exclusion. Profile B first proves the Profile A custody database is absent, then imports only the recovery kit and verified portable facts, creates fresh key material and epoch, commits root recovery, and deterministically supersedes the old device. Temporary profiles, the Profile B database, workers, and the local test server are removed after the run. Edge was not tested, and this result does not infer the frozen Chromium 137 compatibility floor.

## Password guessing and operational limits

The recovery kit is deliberately portable, so theft enables offline password guessing. There is no server throttle or account recovery oracle. Users must choose a high-entropy password and protect kit copies. The frozen Argon2id cost is version 19, operations limit 3, 67,108,864 bytes (64 MiB), parallelism 1. The Slice 3 Chrome 151 benchmark at those parameters measured 123.4 ms, 124.9 ms, and 129.3 ms (median 124.9 ms; worst 129.3 ms). The observed JavaScript heap was 1,790,148 bytes but excludes WASM/native allocations and is not a peak-memory measurement; the configured 64 MiB is the reliable memory-cost bound.

The project folder itself remains plaintext at the filesystem boundary for HC-1/HC-2 public protocol objects and immutable Markdown content. Recovery protection does not encrypt the whole folder or hide filenames, membership metadata, control history, timing, sizes, public keys, commitments, or other public collaboration evidence.

## Explicit limitations and deferred work

- No hardware-backed, Secure Enclave, TPM, passkey, OS-keystore, or user-presence custody is claimed.
- WebCrypto non-extractability prevents standards-compliant export; it does not defend a fully compromised browser profile, origin, renderer, extension, operating system, or live process.
- The selected WebCrypto, HPKE, and libsodium JavaScript/WASM libraries have compatibility and security evidence but have not received a Patchmark-sponsored formal audit.
- IndexedDB durability and browser profile backup behavior remain platform concerns; loss of both local custody and all recovery-kit copies is unrecoverable.
- Enrollment, QR/link exchange, recipient delivery, transport, synchronization, conflict UI, password UX, kit export/import UI, hardware custody, root rotation, and multi-device recovery policy remain deferred.
- Production bundle reachability, startup behavior, and capability enablement remain locked until the final HC-2 audit.

Slice 4 therefore establishes a tested custody/recovery boundary, not a production feature flag. Production collaboration remains disabled.

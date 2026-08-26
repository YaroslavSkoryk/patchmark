# HC-2 final security and architecture audit

Audit date: 2026-08-26
Starting revision: `2e6a9f0579ab9726f2231846c97728e122862ed3` on `users_collab`
Audit scope: HC-1 and HC-2 through Slice 8
Production collaboration enabled: **no**

## Executive readiness decision

HC-1 and HC-2 form a coherent, fail-closed local collaboration foundation.
The implemented authority chain, exact-byte identities, portable persistence,
device custody, recovery, admission, synchronization, and reconstruction paths
have no reproduced critical, high, or medium defect within the collaboration
boundary. No frozen protocol correction was required.

HC-2 is safe to commit and merge while collaboration remains unconditionally
disabled and unreachable. HC-2 is complete as the disabled technical
foundation and qualification milestone. It is not a production collaboration
feature, and this decision does not authorize a route, UI, network transport,
background task, account system, cloud project store, relay, or feature flag.

A later phase may begin disabled user-facing transport and workflow integration
against the existing V2/V3 protocols. Production enablement remains blocked on
separate product integration, browser qualification, content-security policy,
operational abuse handling, dependency remediation, and a new security review.

Two findings outside the collaboration boundary remain open:

- the current repository dependency graph has production and development
  advisories, although none is in the selected HC-2 cryptographic graph; and
- one unchanged application browser regression fails in the human re-anchor
  table-heavy Visual Mode scenario.

Neither finding is caused by HC-2 or reachable through disabled collaboration.
They are retained in the risk register and must not be represented as green.

## Audit method and source coverage

The audit examined the checked-out source rather than relying on prior slice
reports. It scanned all 49 top-level HC-1 modules and all 77 HC-2 modules,
reviewed the authority-bearing and cryptographic implementations directly, and
traced their existing tests. Across collaboration source, 230 calls construct
or parse exact-field records. Static scans found no networking call, timer,
poller, `Math.random`, or UUID fallback in `lib/collaboration/hc2/`.

Primary source areas inspected were:

- `lib/collaboration/`: canonical CBOR, identities, content, semantic/control
  records, capabilities, stores, reconstruction, projector, roots, checkpoints,
  snapshots, consolidation, and bootstrap;
- `lib/collaboration/hc2/`: authority classification, limits, portable-folder
  storage, IndexedDB coordination, custody, recovery, enrollment, V2 transport,
  V3 synchronization, and qualification;
- `lib/collaboration-shadow/` and `lib/project/patchmark-project.ts`: the only
  production collaboration seam;
- every `scripts/collaboration*.test.mjs`, collaboration type test, independent
  Python verifier, browser runtime, and frozen fixture;
- `package.json`, `package-lock.json`, installed package manifests, generated
  production manifests/chunks, and live npm registry/advisory responses.

No production or protocol implementation file was changed by this audit. The
audit changes documentation only.

## Architecture map

| Layer | Authoritative input and output | Trust and persistence boundary | Cryptographic binding and failure/recovery | Evidence and limitation |
| --- | --- | --- | --- | --- |
| 1. Native duplication/bootstrap | Exact source-project snapshot enters a fresh destination; HC-1 genesis objects, control state, and initial projection leave | Source is read-only evidence; destination portable records are authoritative only after verification and commit markers | Source SHA-256 and canonical HC-1 identities bind the plan; any source drift, occupied destination, or partial operation blocks/resumes exactly | Bootstrap, shadow, HC-1 hardening, Slice 4, and Slice 8 tests. No in-place migration or external Markdown materialization |
| 2. Identity allocation and aliases | Securely allocated entity IDs and digest-derived IDs; local aliases remain operational only | Entity IDs are generated; content/event/root IDs are derived; aliases, names, handles, and paths cannot grant authority | Strict namespace/version/Base32 parsing; allocation collision is rejected | Canonical, contract, bootstrap, and hardening vectors. Human identity confirmation remains out of band |
| 3. Canonical encoding and hashes | Typed protocol values become exact canonical CBOR, SHA-256 digests, Base32 IDs, and signature preimages | The canonical byte string is the identity boundary; decoders accept no equivalent alternate encoding | Domain-separated preimages; strict re-encoding equality; malformed, non-NFC, duplicate, misordered, indefinite, or deep inputs fail | Node, independent Python where applicable, and Chrome vectors. No Unicode compatibility normalization beyond required NFC |
| 4. Immutable object storage | Exact Markdown, revisions, payloads, actions, events, controls, and attestations become immutable addressable records | Portable object bytes plus verified marker are durable evidence; indexes are rebuildable | Object kind/ID/project/dependency and exact digest are reverified on write and reopen | HC-1 store/event tests and HC-2 exact-object verifier. Storage does not itself accept an event |
| 5. Authority, sequence, quarantine, recovery | Accepted control state and signatures classify candidates; accepted semantic/control sets and explicit quarantine leave | Device-private sequence/CAS continuity is locally authoritative for safe signing; candidates and forks have no authority | Accepted signer resolution, device sequence, predecessor, revocation cutoff, and root supersession bind acceptance | HC-1 hardening, event/control reconstruction, Slice 4/5. Denial-of-service by supplying invalid candidates remains possible |
| 6. Projection and conflicts | Accepted event/control sets enter deterministic reducers; canonical projection, heads, conflicts, tombstones, and rejections leave | Projection caches are rebuildable and cannot add accepted input | Causality and exact contender sets prevent arrival-order winners; explicit eligible resolution is a new accepted event | Node/Chrome projector and two-profile convergence. Semantic policy is frozen to reducer v1 |
| 7. Roots, checkpoints, snapshots, acknowledgements | Accepted history and projection categories become five component roots, composite root, checkpoint, state blob, snapshot, acknowledgements, and receipts | Roots/checkpoints are portable authoritative evidence but never signing authority | Domain-separated Merkle construction, signed snapshot/acknowledgement preimages, exact checkpoint verification | Node/Python/Chrome root vectors and reopen comparisons. Admission may intentionally start at a current-state boundary |
| 8. Portable-folder authority | Verified immutable objects, markers, batches, replica metadata, continuity, and recipient envelopes | User-selected folder is durable portable evidence; plaintext content at rest; filenames/permissions are outside browser crypto | Strict relative namespace, exact readback/rehash, data then object marker, batch marker last | Slice 2 storage/failure tests and browser reopen. Filesystem copying, rollback, deletion, and physical access remain environmental risks |
| 9. IndexedDB coordination | CryptoKey structured clones, KEKs, wrapped epochs, sequence/head/generation CAS, reservations, and journals | Device-private origin state is authoritative only for that device's cryptographic/sequence safety; it cannot replace portable evidence | Strict transactions, exact retry commitments, nonce collision records, reopen self-tests | Slice 2–5 browser tests. Profile loss retires the device and requires root recovery |
| 10. Web Locks and OPFS | Lock hints serialize friendly callers; OPFS mirrors verified folder bytes | Web Locks are advisory; IndexedDB CAS is decisive. OPFS is disposable and never authoritative | Lock loss cannot bypass CAS; OPFS hit requires byte equality with verified folder content | Real multi-context browser tests. Unsupported/evicted OPFS is a cache miss, not data loss |
| 11. Cryptographic providers | WebCrypto/native handles and reviewed packages implement the one frozen suite | Provider internals and workers are capability boundaries; raw long-lived private keys never cross a public codec | Ed25519, X25519, single-use HPKE Base mode, AES-GCM local wraps, Argon2id, XChaCha20-Poly1305 | RFC/frozen vectors in Node/Python/Chrome. Non-extractable does not imply hardware-backed or same-origin compromise resistance |
| 12. Recovery kits/profile loss | Password-protected offline root kit plus verified portable folder authorizes a new root-recovery transition | Kit is external encrypted recovery evidence; root seed exists only inside a fresh worker; old profile state is not reconstructed | Argon2id/XChaCha authenticated kit, exact root public binding, typed root preimage, new device/keys/epoch | Slice 4 and Slice 8 browser evidence. Lost kit plus loss of all owner devices is unrecoverable |
| 13. Enrollment/membership/epochs | Accepted owner/control state, invitation, possession proofs, and transition intent produce accepted membership/control and a complete new epoch recipient set | Invitation/request/proof/delivery/status records have `authority: "none"`; only accepted HC-1 control changes authority | Owner/device/key/control bindings, single-use invitation, both-key possession, recipient completeness, epoch commitment | Slice 5 Node/Python/Chrome. Revocation is prospective and cannot recall prior plaintext/ciphertext |
| 14. V2 admission transport | One owner-authorized admission selection becomes signed, HPKE-encrypted canonical containers and an atomic imported boundary | Public header is opaque framing; signed plaintext and existing HC-1 validators decide acceptance | Complete nine-field header is AAD; manifest, purpose, recipient, control, epoch, stream, and signature bindings are checked | Slice 6 vectors and two-profile admission. New member records `full_history_verified: false` |
| 15. V3 synchronization | Verified committed portable inventory and explicit requests produce bounded encrypted transfer rounds and confirmations | Inventory/index/status/planner outputs have `authority: "none"`; only imported verified HC-1/HC-2 records may become visible | Snapshot, request, response, dependency, stream predecessor, authority, epoch, HPKE, and signature bindings | Slice 7 Node/Python/Chrome and reordered convergence. Manual foreground transfer only; no live discovery |
| 16. Disabled qualification workflow | Durable evidence plus one explicit injected operation produces non-secret frozen status guidance | Facade owns no storage, crypto, projector, or authority and schedules no continuation | Source digest/revision CAS guards every call; fork/corrupt/permanent quarantine blocks | Slice 8 Node/Chrome composite qualification. Evidence composition is not production UI or an independent authority layer |
| 17. Production isolation | Existing single-user app imports only the inert shadow entrypoint; HC-2 has no production import | Production branch returns disabled synchronously; heavy shadow chunk is deferred and absent from initial page graph | Attempted environment enablement is ignored before factories, dynamic import, browser API, storage, randomness, workers, network, timers, or UI effects | Production build, manifest/chunk inspection, import-safety and production-lock tests. Any future import requires a new review |

No layer gains authority because it stores, transports, indexes, caches,
displays, labels, derives, or reports a record. Authority is created only by a
validated accepted HC-1 semantic/control transition under the accepted signer,
role, device, sequence, predecessor, project, epoch, and causality rules.

## Trust-boundary map

| Boundary | Untrusted side | Admission rule | Failure result |
| --- | --- | --- | --- |
| Legacy source to collaboration destination | Mutable single-user source and local UI state | Exact source snapshot, fresh destination, explicit bootstrap plan | No destination authority; source remains unchanged |
| Portable folder to accepted history | Files, names, order, indexes, partial writes | Strict address, marker-last visibility, exact length/hash/identity/project/dependency verification | Invisible, retryable, corrupt, forked, or read-only |
| IndexedDB to device operation | Stale tabs, rollback, forged operational state | Exact generation/head/sequence CAS, structured-clone key self-test, reservation/journal match | Stale/fork/recovery-required; never fallback authority |
| Cache/index/status to reconstruction | Malicious or stale derived records | Rebuild from verified committed portable records | Cache ignored/evicted; status cannot change acceptance |
| Transport file to local staging | Replay, reorder, truncate, substitute, wrong peer | Strict framing/bounds, HPKE AAD, Ed25519, manifest, stream, authority, epoch, and object validation | Reject/quarantine/gap/fork with no partial visibility |
| Recovery kit to root authority | Stolen kit, wrong password, corrupted payload | Password KDF/AEAD, public root binding, worker-only seed, typed control preimage | Uniform recovery failure or explicit abort |
| Browser provider to protocol | Package/platform failure or misuse | Fixed suite, opaque native handles, exact key usage, single-use context, secret-free errors | Fail closed; no algorithm/randomness fallback |
| Qualification to real operations | Status, UI guidance, paths, handles, diagnostics | Injected existing operation port and durable evidence revision; `authority: "none"` | Blocked or explicit error; no scheduled retry |
| Production app to collaboration code | Environment variables and normal page load | Hard production-disabled state before receipt factory/dynamic import | Zero collaboration activity and no HC-2 import |

## Threat model

| Threat | Prevented or detected behavior | Residual risk | Recovery path |
| --- | --- | --- | --- |
| Malicious collaborator | Cannot forge another accepted signer, change exact bytes under an ID, smuggle unknown fields, or turn transport/status into authority | An authorized role can perform its allowed actions and can withhold/flood valid work | Revoke prospectively, resolve accepted conflicts, quarantine invalid candidates |
| Revoked member/device | Post-cutoff authoring/export is rejected before cryptography; revoked recipients are excluded from replacement epoch | Already possessed plaintext, keys, folders, and ciphertext cannot be recalled | Rotate epoch, preserve cutoff evidence, enroll/recover an authorized replacement |
| Stale or duplicate tab | Web Lock reduces contention; IndexedDB CAS/reservations detect stale head/generation/sequence | Lock service can disappear and stale tabs can cause denial/fork evidence | Reload accepted state, exact retry from journal, or explicit fork handling |
| Lost browser profile | Missing non-extractable keys cannot be silently recreated as the old device | Folder alone cannot regain owner authority; lost kit plus all owner devices is terminal | Verified kit plus folder creates a new device, keys, continuity, and epoch |
| Corrupted portable folder | Exact address, marker, length, SHA-256, ID, project, dependency, root, and checkpoint verification detect corruption | Physical deletion/rollback can remove evidence or cause denial | Restore authenticated backup/copy or fail read-only; never invent replacement bytes |
| Partial filesystem write | Data is invisible until exact object marker and final batch marker; readback is verified | Filesystem may deny cleanup or further writes | Resume exact journal/reservation; repair only authenticated shorter pending evidence |
| Portable/IndexedDB rollback | Head/generation/sequence/stream predecessor mismatches produce stale, gap, or fork outcomes | Coordinated rollback of every local copy may be indistinguishable without an external newer witness | Compare another replica/backup; require explicit recovery/fork decision |
| Replayed/reordered/duplicated/truncated/substituted bundle | Canonical framing, manifest, AAD, signature, stream CAS, and exact commitments reject or make duplicate idempotent | Size/timing metadata and denial remain visible | Retry exact committed bytes or request the missing predecessor |
| Same-sequence conflicting events | Device sequence and same-slot different-commitment evidence create explicit fork/quarantine | Deliberate equivocation can halt progress | Root recovery/supersession or explicit administrative resolution; never arrival winner |
| Malicious index/cache/diagnostic/status | Cannot supply portable bytes, accepted signatures, or CAS authority | Can mislead a UI if the UI ignores verified status contracts | Rebuild/evict and show only verified reconstruction evidence |
| Untrusted transport | Public framing leaks no semantic identity; ciphertext/header substitution fails authentication | File size, count, timing, and user-selected sharing channel remain observable | Use another user-mediated channel; authenticated bundle semantics remain identical |
| Compromised future signaling/delivery | Signaling cannot grant membership or alter V2/V3 authentication | Can correlate endpoints, delay, replay, drop, or substitute offers/files | Fail to manual encrypted-bundle fallback; separate relay/rendezvous review required |
| Stolen recovery kit | Encryption resists offline use according to password and Argon2id cost; kit is bound to project/root | Weak password permits offline guessing; copying cannot be detected or revoked | Use strong separately held password/kit; recover and rotate if compromise is suspected |
| Wrong recovery password | Uniform authenticated failure reveals no decrypted root seed or detailed cause | Timing and repeated attempts are locally observable; no service-side rate limit exists | User retries explicitly; product phase must design local abuse/rate UX |
| Dependency/provider compromise | Exact pins/lock integrity, narrow wrappers, independent vectors, worker isolation, and no install scripts reduce exposure | Same-origin malicious code can use available keys; packages/browser are not formally proven | Advisory monitoring, reviewed upgrades, CSP/Trusted Types, rotate/recover after compromise |
| Memory inspection | Copies are bounded and best-effort wiped; recovery material remains worker-local | JS/WASM/native buffers, GC, swap, crash dumps, and live process inspection are not guaranteed erased | Minimize lifetime, terminate workers, close profile; make no secure-deletion claim |
| Oversized/deep input denial | Definite canonical CBOR, depth 128/256 dependency bounds, exact byte/count budgets, and preflight checks reject `+1` cases | Work within valid maxima can still consume significant CPU, memory, disk, or user time | Explicit bounded operations, quota/read-only outcomes, user cancellation and retry |

## Canonical protocol and identity review

The v1 canonical CBOR implementation accepts only unsigned integers through
`2^64-1`, byte/text strings, dense arrays, text-keyed maps, booleans, and null.
It rejects negative integers, floats, tags, indefinite forms, reserved
additional information, trailing bytes, non-shortest integer/length encodings,
invalid UTF-8, unpaired UTF-16 surrogates, non-NFC text, duplicate keys,
misordered encoded keys, sparse arrays, and nesting deeper than 128. Decoding
must re-encode byte-identically.

Markdown blob identity commits to the exact Markdown bytes; display text
normalization never rewrites stored Markdown. Entity IDs and digest IDs use
separate closed namespaces. Digest IDs commit to a domain-separated canonical
preimage. Circular values are excluded: signatures, container IDs, and
ciphertext-derived IDs are derived only after their non-circular cores exist.
Cross-kind, cross-project, cross-version, unknown suite/role/kind/purpose, and
noncanonical lowercase-unpadded Base32 inputs are rejected.

Exact-limit and `+1` tests cover the 16 MiB object boundary, nested signed/core
and ciphertext bounds, 256 MiB bundle, count limits, quota arithmetic, and V3
per-invocation page/object/byte/message/round/dependency limits. Frozen fixtures
use compact deterministic descriptors rather than literal maximum payloads.

### Frozen fixture inventory

All hashes were recomputed from the checked-out bytes. The first nine files are
the pre-Slice-8 frozen protocol/evidence fixtures guarded by the production-lock
test; the final Slice 8 summary template is deterministic qualification
evidence, not a wire protocol.

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `collaboration-canonical-v1.json` | 24,402 | `f178eb0510471ef9a9ed6835840b75c1bf9b21a22b445c3ce00275582182726b` |
| `collaboration-roots-v1.json` | 16,805 | `42189802cee24766e73e974fd09b6e1bd9f612c90da184399a82bea91a1e211e` |
| `collaboration-review-response-evidence-v1.json` | 1,377 | `7b9dc41a3407549167286aaed20f32c967db5878f2705d219627b08d4ba30e67` |
| `collaboration-hc2-slice1-v1.json` | 12,711 | `534ec34c32cd208759c135c77d69dcd7cab6fa7cfac93ba6f7680c03171f9cbc` |
| `collaboration-hc2-slice3-v1.json` | 4,997 | `a74b3f3f171f1b23a6b8b60c5131e0d15a5a36ecd589d0d5d5b8f5997c47bb73` |
| `collaboration-hc2-slice4-v1.json` | 10,530 | `81b5babfff1faa4092a27ccab598dc78eb47c4ba6609baac59132ef9730a4e50` |
| `collaboration-hc2-slice5-v1.json` | 7,720 | `6cbb2877156de12b54d976e100cb94de0b1f85d1f4b20f8c8c7284df0a4d4e89` |
| `collaboration-hc2-slice6-v2.json` | 5,201 | `4400b16f1de78f3ae49f04844f85c7278dbc28291dd772bdfad1c6ea0b69eb4c` |
| `collaboration-hc2-slice7-v3.json` | 6,632 | `98450f518c9827ec0e310aa2a7a66d99fb4ba5c33f0b0aa3fddb75b4f95a5df1` |
| `collaboration-hc2-slice8-qualification-template.json` | 856 | `735fdbb8df9b93367d5907592e78e7e3e00050740da312e3b6227bc260f5dc46` |

Total collaboration fixture size is 91,231 bytes. No fixture changed during
the audit.

## Authority review

| Actor or record | May do | Must not do |
| --- | --- | --- |
| Owner on accepted active device | All editor work; invitation, membership, device, role, epoch, and ordinary control changes; conflict resolution; root-recovery initiation under the separate offline root ceremony | Bypass sequence/predecessor/control state, deliver replacement epoch to revoked devices, recreate lost private state |
| Editor on accepted active device | Edit Markdown; create/adopt revisions; comments/replies/patches; accept/reject/authorize safe merge; resolve content conflict; create documents/groups | Invite/remove/change role, authorize/revoke devices, rotate epoch, recover control, or perform owner control actions |
| Reviewer on accepted active device | Read; comment/reply/edit/resolve comment; propose patch; import model work | Adopt revisions, accept/reject or authorize merges, change membership/device/role/epoch, resolve content conflict, or recover control |
| Designated active control device | Issue the next ordinary accepted control transition for an eligible owner | Treat a second ordinary control tip or stale device as winner |
| Offline root recovery capability | Sign only constructed initial-foundation/root-recovery control-event preimages | Sign arbitrary bytes or resurrect the lost device's keys/sequence |
| Portable object/checkpoint/snapshot | Supply verifiable project evidence | Authorize a new operation merely by existing in a folder |
| Device-private authoritative state | Protect local keys, epoch use, sequences, streams, and CAS continuity | Satisfy portable evidence, membership, semantic, or control authority by itself |
| Planner, candidate, fork, index, cache, OPFS, status, diagnostic, handoff, path, handle, UI | Guide, stage, cache, display, or report with `authority: "none"` | Create membership, accepted history, crypto authority, conflict winner, or stream continuity |

Root recovery creates a new device identity, Ed25519 key, X25519 key, KEK,
sequence continuity, and epoch. It supersedes rather than resurrects the lost
device. Revoked devices are excluded from the complete replacement-epoch
recipient manifest and are rejected for post-cutoff work and outbound crypto.
Revocation does not recall bytes or secrets already possessed.

## Cryptographic review

- **Randomness:** `WebCryptoRandomSource` has no fallback. It bounds a request
  at 16 MiB and calls `getRandomValues` in at most 65,536-byte chunks.
- **Ed25519/X25519:** private keys are generated non-extractable; public keys
  are exact algorithm-tagged canonical values. Opaque WeakMap/native handles
  bind the key ID, pair, algorithm, usage, and public encoding. Reopen tests
  sign/verify and HPKE round-trip the structured-cloned keys.
- **HPKE:** suite is fixed to RFC 9180 Base mode,
  DHKEM(X25519, HKDF-SHA-256), HKDF-SHA-256, and AES-256-GCM. Each V1/V2/V3
  operation owns one fresh context and one seal/open. Sender setup yields exact
  `enc`; the complete final nine-field header containing that `enc` is
  canonical AAD; `info` remains a versioned non-circular pre-setup binding.
- **Local epoch custody:** 32-byte epoch secrets are wrapped by non-extractable
  AES-256-GCM KEKs with project/device/epoch/generation binding. Nonce
  collisions are durably rejected and do not trigger random fallback/retry.
- **Recovery:** the kit freezes Argon2id v19, opslimit 3, 64 MiB memory, a
  16-byte salt, a 32-byte derived key, and XChaCha20-Poly1305 with 24-byte nonce.
  Root seed and password use are isolated to a fresh single-operation worker;
  workers terminate and buffers are wiped best effort.
- **Errors:** provider errors use a closed secret-free code/message set. Wrong
  password, corrupt kit, and binding failure do not expose decrypted details.
- **Custody limitation:** WebCrypto non-extractability is not a hardware,
  enclave, secure-deletion, forward-secrecy, or same-origin compromise claim.

## Dependency and advisory review

Live registry metadata on 2026-08-26 matched the lockfile for the selected HC-2
cryptographic graph:

| Package | Selection | Integrity | License | Lifecycle/install scripts |
| --- | --- | --- | --- | --- |
| `@hpke/core` | direct exact `1.9.0` | `sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==` | MIT | none published |
| `@hpke/common` | transitive locked `1.10.1` | `sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw==` | MIT | none published |
| `libsodium-wrappers-sumo` | direct exact `0.8.4` | `sha512-ql7hcgulKZ3ekfa2DGAogcCKsWU0diA/0nArz1CFzh93WQdb46/Kj18ka/Hifq6uA3Ush34Pc6vU/6HXeRwUkg==` | ISC | none published |
| `libsodium-sumo` | transitive locked `0.8.4` | `sha512-TMtHShQfVVsaxDygyapvUC3o7YsPgXa/hRWeIgzyFz6w5k/1hirGptCxp1U7XwW3rCskaTTYKgV10v86UiGgNw==` | ISC | none published |

`npm audit` and `npm audit --omit=dev` report no advisory for those four
packages. The full selected graph is unchanged and the lockfile contains one
copy of each transitive cryptographic package.

The repository-wide result is not clean:

- full graph: 7 findings, 6 high and 1 moderate;
- production-only graph: 6 findings, 5 high and 1 moderate;
- affected unrelated paths: direct `next@15.5.20`, its `postcss@8.4.31` and
  `sharp@0.34.5` paths, direct `@mdxeditor/editor@3.55.0` through
  `js-yaml@4.1.1`, `nanoid`, and development `brace-expansion` paths.

The registry reports fixes are available, but upgrading the application/editor
stack is outside this frozen collaboration audit and may require compatibility
work. This open high-severity repository risk must be remediated before any
production collaboration enablement and under the normal application security
process. It is not attributed to the selected HC-2 packages.

## Persistence, crash consistency, and recovery review

Portable addresses are strict safe relative paths under the versioned folder
root. An object is staged, written, closed, reopened, rehashed, and verified;
its object marker is written afterward. A batch becomes visible only after all
objects/dependencies/markers verify and its batch marker is written last.
Admission imports install candidate custody before the combined final marker.

IndexedDB uses strict transactions for generation, accepted head, device
sequence, stream high-water, reservations, nonce history, and journals. An
exact retry must match the committed plan/bytes; a differing retry becomes a
fork/collision. Web Locks improves same-profile exclusion but cannot authorize
or replace CAS. OPFS entries are accepted only against exact verified folder
bytes and are deleted/ignored on mismatch.

The tested interruption classes have these outcomes:

- before a visibility marker: staged/invisible and explicitly resumable;
- after immutable bytes but before a marker: invisible until exact repair;
- after portable visibility but before local finalization: exact journal resume;
- after local CAS but before reopen evidence: reopen and verify, never replan;
- permission/quota/read-only failure: explicit blocked/read-only outcome;
- stale tab/local-ahead/rollback/gap/fork/ambiguous folder: explicit typed
  outcome with no winner or reset selected automatically;
- profile loss: old device cannot be restored; verified kit and folder enroll a
  new device or recovery fails closed.

## V1/V2/V3 compatibility and synchronization review

V1, V2, and V3 use separate versions, record kinds, identities, domains, and
closed payload unions. V1 rejects V2/V3 fields. V2 is one encrypted signed
canonical admission/replication transport, not a plaintext manifest sidecar.
V3 synchronization is independently versioned and does not broaden V2.

The complete public header in V2 and V3 has only:

`magic`, `envelope_version`, `suite_id`, `encapsulated_key_bytes`,
`envelope_id`, `recipient_routing_tag`, `chunk_ordinal`, `chunk_count`, and
`ciphertext_length`.

Project, person, membership, device, control, epoch, purpose, object, stream,
and session identities remain inside signed ciphertext. The complete header is
HPKE AAD. The header necessarily leaks framing, size, count, timing, and an
opaque routing tag.

V3 inventory is generated through stable reads of verified committed portable
records, not object indexes or OPFS. Exact descriptors, pages, requests,
responses, dependency closure, confirmations, and planner/status values have
`authority: "none"`. Bounds are checked before expensive operation where the
contract permits. Outbound authority, current recipient key, revocation, head,
and epoch custody are re-resolved before randomness, signing, or HPKE.

Duplicate exact imports are idempotent. Gaps, stale replay, wrong predecessor,
same-position different commitment, same-ID different bytes, and snapshot
advance remain explicit. Arrival order cannot select a semantic winner. Exact
retry reuses journaled bytes. Equal inventory is insufficient by itself:
confirmation compares authoritative and projected reconstruction commitments.

## End-to-end browser qualification

The Slice 8 composite qualification passed on `Chrome/151.0.7922.174`. It
invokes the real isolated-profile custody/recovery, enrollment/epoch, V2
admission, and V3 synchronization harnesses and reports:

- 23 composite assertions, 69 focused facade assertions, protocols 1/2/3, and
  source-project immutability;
- real persisted non-extractable Ed25519/X25519/KEK custody;
- mandatory recovery kit, invitation, both-key possession, enrollment,
  recipient-complete epoch rotation, V2 admission, receipt, and
  `full_history_verified: false` on B;
- genuinely concurrent titles from A and B plus offline comment, patch, reply,
  and review-batch families;
- forward and reversed arrival orders, replay/idempotence, 11 bounded V3
  rounds under forced page size 2, and zero-record already-converged exchange;
- one identical legitimate conflict with no arrival winner; reviewer resolution
  rejected; eligible explicit resolution synchronized and reopened with zero
  remaining conflicts;
- post-cutoff authoring and export rejected with zero cryptographic calls;
  revoked B excluded from the replacement epoch while the already-delivered
  ciphertext limitation remains explicit;
- profile loss recovery with a new device identity and keys, no restoration of
  old sequence/reservations/private state, and seven profile reopens in the
  composite evidence;
- exact equality for 19 categories: accepted object bytes/identities, accepted
  semantic events, accepted controls, semantic frontier, control head,
  membership/device authority, current epoch, canonical projection bytes,
  revision heads, conflicts, tombstones, reducer rejections, five component
  roots, composite root, checkpoint, state blob, snapshot, acknowledgements,
  and receipts;
- no accepted object from indexes/OPFS/arrival order, no synchronization planner
  call in the V2 convergence harness, zero idle activity, and profile/server/
  worker/database cleanup.

The qualification is an evidence-composed disabled harness, not a shipped
single workflow controller. The synchronization/convergence scenario itself
uses one isolated A/B pair; focused custody and enrollment profile ceremonies
are composed into the final result. Product workflow continuity remains next-
phase work and cannot be inferred from the composite report.

## Production-isolation evidence

An optimized Next.js production build passed with
`NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW=development_shadow` set as an
attempted enable signal. Production still reported `disabled`, made zero
receipt-factory calls, and ignored the attempted enablement.

The production route graph contained only the existing root, not-found, and
three regression pages. Regression pages return not-found in production unless
the dedicated test-route environment is explicitly set. No route, action,
endpoint, feature flag, or dynamic import reaches HC-2.

The only production collaboration import is the pre-existing inert
`collaboration-shadow/entrypoint.ts`. It returns synchronously before receipt
factories or its heavy dynamic chunk. The 424,120-byte deferred shadow chunk is
not in any initial page manifest. It contains HC-1/control compatibility code,
including the frozen HC-2 suite literal used by HC-1 control contracts, but no
HC-2 provider, storage, recovery-worker, V2/V3 synchronization, or qualification
import. Direct manifest/chunk scans found no `@hpke/core`, libsodium,
root-recovery worker, V3 synchronization, or qualification module in the
initial production graph.

Import-safety loaded 21 HC-2 entry/provider modules while poisoning browser,
storage, crypto, random, worker, timer, network, and UI globals; none was
touched. Production-lock scanned 77 HC-2 modules, found zero HC-2 production
imports, verified the bounded provider barrel and worker-private root seed, and
rehashed all nine prior frozen fixtures.

## Browser evidence

Only Chrome 151 was exercised. No Edge binary or Chromium 137 floor was
available, so compatibility with Edge, Chrome 137, or a minimum supported
Chromium release is not inferred.

- 11 collaboration browser/vector suites passed: HC-1 canonical/projector/
  roots and HC-2 Slice 1 through Slice 8.
- Node/Chrome equivalence passed for canonical/projector/V2/V3 data; the
  relevant HC-2 and root vectors also matched independent Python evidence.
- All 41 unique repository browser commands were attempted in their intended
  production or development/test-route environment. 40 passed.
- `test:human-reanchor-foundation-browser` fails unchanged at
  `scripts/comment-reanchor-browser.test.mjs:172` with “Visual re-anchor must
  not collapse table-heavy editor content.” It reproduced twice before audit
  edits on the starting revision. The test imports no collaboration module and
  remains an unrelated application regression; no assertion was skipped or
  weakened.

## Explicit no-centralization architecture decision

Status: **accepted for future collaboration work**.

1. Patchmark projects remain complete local replicas.
2. No Patchmark account is required for project authority.
3. No Patchmark cloud database is the master project.
4. No mandatory Patchmark-operated relay or signaling service is part of the
   architecture.
5. Manual encrypted bundle exchange remains a complete supported mechanism.
6. Future direct synchronization uses user-mediated invitation and
   synchronization links, codes, or QR codes. Opening/scanning one never grants
   membership or authority and never contains private keys, epoch plaintext,
   document content, or authority that bypasses invitation, key-possession, and
   owner-authorization ceremonies.
7. Ordinary users do not configure protocols or infrastructure. After an
   offer/answer exchange, Patchmark may automatically try the most convenient
   approved direct mechanism.
8. A local-network or future peer-to-peer session transports the same
   authenticated V3 synchronization protocol; transport cannot become project
   authority.
9. Remote peer-to-peer establishment requires offer/answer or a rendezvous
   mechanism. Patchmark must not promise impossible one-way automatic
   discovery.
10. NAT/firewall failure is handled honestly by one-click encrypted bundle
    sharing through the operating system or a user-selected channel.
11. Optional user-controlled/self-hosted adapters may be considered later but
    cannot become authority.
12. Any centralized rendezvous or relay proposal requires a separate explicit
    architecture decision, metadata/privacy analysis, abuse model, and security
    review. It is not authorized by HC-2.

## Known limitations

- The selected portable folder stores plaintext immutable Markdown and public
  collaboration evidence at rest. V2/V3 exchange files and recovery kits are
  encrypted; the project folder is not an encrypted vault.
- Revocation is prospective. It cannot erase memories, copied folders, keys,
  plaintext, or ciphertext already delivered.
- Non-extractable keys may be software-backed. A compromised same-origin
  application/profile can use keys while it controls the origin.
- No secure deletion, hardware protection, post-compromise security, or formal
  forward-secrecy guarantee is claimed. New HPKE contexts prevent reuse but do
  not erase already exposed plaintext.
- JavaScript/WASM/native memory wiping is best effort and cannot cover garbage
  collection, browser internals, swap, crash dumps, or live inspection.
- Manual file transfer exposes file size/count/timing and permits denial,
  withholding, duplication, and social substitution attempts.
- Current-state admission intentionally does not verify all unavailable prior
  history and records `full_history_verified: false`.
- Fine-grained document grants, history pruning, garbage collection,
  encrypted-at-rest folders, background sync, accounts, network discovery,
  relay/signaling, and polished UI remain out of scope.
- Loss of every authorized owner device and the recovery kit is unrecoverable.
- Browser qualification is Chrome 151 only.
- Valid maximum-size operations can still be expensive even though inputs and
  invocations are bounded.

## Risk register

| ID | Severity | Evidence | Disposition | Owner |
| --- | --- | --- | --- | --- |
| HC2-01 | Medium, production blocker | Same-origin code can use live non-extractable keys; no CSP/Trusted Types production integration exists | Accepted while unreachable; require CSP, Trusted Types, minimized chunks, and new review before enablement | Next integration phase/security |
| HC2-02 | Medium, disclosed design limit | Portable folder contains plaintext Markdown/history | Accepted local-first disclosure; encrypted-at-rest vault requires separate ADR | Product/security |
| HC2-03 | Medium, disclosed design limit | Revocation cannot recall delivered data; manual transport leaks size/timing | Accepted and tested; product must communicate honestly | Product/security |
| HC2-04 | Medium, production blocker | Only Chrome 151 tested; Edge and Chromium floor unavailable | Do not infer support; qualify the declared browser window before enablement | Platform QA |
| HC2-05 | Low | JS/WASM wiping and non-extractability are best effort/software dependent | Keep secrets short-lived/worker-local; no hardware or secure-deletion claim | Security/platform |
| HC2-06 | Low | Composite qualification is not a shipped continuous workflow | Implement disabled product workflow over existing ports without creating authority | Next integration phase |
| APP-01 | High, unrelated open risk | `npm audit`: 5 production high + 1 production moderate; full graph adds 1 development high | Remediate Next/MDX/transitive graph separately; block production collaboration until reviewed | Application dependency owner |
| APP-02 | Low, unrelated regression | Human re-anchor browser assertion fails twice on unchanged baseline | Preserve failing test; fix in the application UI track | Editor/UI owner |

No critical, high, or medium implementation defect remains open within the
disabled HC-1/HC-2 protocol, authority, crypto, storage, recovery, admission,
synchronization, or production-isolation boundary.

## Audit corrections

No concrete collaboration defect was reproduced, so no production code,
protocol parser, fixture, dependency, lockfile, limit, identity, domain,
authority rule, or test assertion was changed. The only audit changes are this
document and the HC-2 README link/status. Consequently no corrective regression
test was added. Existing focused regressions were rerun instead.

## Deferred production work

The next phase should remain disabled and focus on:

1. a user-mediated invitation/synchronization offer/answer format that carries
   no authority or secret and selects manual OS sharing as the universal
   fallback;
2. a foreground UI that invokes one existing bounded qualification/V2/V3
   operation at a time and shows explicit gap/fork/read-only/recovery outcomes;
3. supported-window Chrome and Edge qualification, runtime probes, accessibility,
   cancellation, quota, permission, and recovery-abuse UX;
4. strict production CSP/Trusted Types, worker and chunk isolation, secret-free
   diagnostics, dependency upgrades/monitoring, and incident response;
5. a separate ADR and security review before any rendezvous, relay, direct
   networking, automatic retry, watcher, timer, service worker, account, or
   cloud storage proposal.

The phase must reuse the frozen authenticated synchronization protocol and may
not make transport, link, code, QR, path, handle, cache, UI, server, or account
authoritative.

## Validation commands and results

The following commands were run from the starting checkout. Browser commands
used isolated Chrome profiles and localhost-only test servers.

| Command | Result |
| --- | --- |
| Generate every `test:*` name from `package.json` excluding names containing `browser`, then `npm run --silent "$test_name"` for each | 93/93 passed. The production-shadow test initially lacked `.next`; after the required build it passed without modification |
| `npm run test:collaboration-canonical-browser` | Passed; Chrome 151; 9 Base32, 46 CBOR, 11 object, 3 SHA-256, 4 signature vectors |
| `npm run test:collaboration-projector-browser` | Passed; Node/Chrome exact-byte equivalence |
| `npm run test:collaboration-roots-browser` | Passed; Node/Chrome equality, with independent Python root verifier also passed |
| `npm run test:collaboration-hc2-slice{1..8}-browser` (each explicit script) | 8/8 passed; Slice assertion counts 1: vector equivalence, 2: 21, 3: 28, 4: 39, 5: 25, 6: 90, 7: 90, 8: 23 composite |
| Every remaining unique browser command from `package.json` in its intended server environment | 29/30 passed; the one unchanged unrelated human re-anchor failure is recorded above. Overall unique browser commands: 40/41 passed |
| `python3 scripts/collaboration-hc2-slice1-independent.py`, Slice 3/4/5/6/7 independent verifiers, root verifier, review-evidence verifier | 8/8 passed; all are included in the 93-script non-browser collection and import no Patchmark implementation where specified |
| HC-2 type scripts for Slice 1 through Slice 5 plus HC-1 type scripts through normal `test:*`/typecheck paths | Passed |
| `NODE_ENV=production NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW=development_shadow npm run build` | Passed; optimized Next.js 15.5.20 build, attempted enable ignored |
| `npm run test:collaboration-shadow-production` | Passed; disabled, zero factory calls, deferred heavy chunk absent from initial page |
| `node ... scripts/collaboration-hc2-import-safety.test.mjs` | Passed; 21 modules, zero poisoned globals touched |
| `node ... scripts/collaboration-hc2-production-lock.test.mjs` | Passed; 77 modules, zero production HC-2 imports, nine frozen fixtures unchanged |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `git diff --check`, conflict-marker scan, and trailing-whitespace scan | Passed |
| `npm audit --json` | Completed: 7 unrelated findings (6 high, 1 moderate), zero selected HC-2 crypto-graph findings |
| `npm audit --omit=dev --json` | Completed: 6 production findings (5 high, 1 moderate), zero selected HC-2 crypto-graph findings |
| npm registry metadata for the four exact selected crypto artifacts | Integrity/license/repository/version matched lockfile; no lifecycle/install scripts |
| `shasum -a 256 scripts/fixtures/collaboration-*.json` | Passed; hashes recorded above |

The final rerun stopped the localhost test server and removed generated `.next`,
TypeScript build-info, test profiles, databases, servers, workers, and caches.
Only this audit and its HC-2 README index entry remain as worktree changes.

## Final decision

- HC-2 safe to commit and merge while disabled: **yes**.
- HC-2 disabled foundation milestone complete: **yes**.
- Production collaboration complete or enabled: **no**.
- Safe next scope: disabled user-facing/manual transport workflow and direct-
  connection design that reuses V3, with no new authority and no networking
  implementation implied by this audit.

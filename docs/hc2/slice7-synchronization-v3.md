# HC-2 Slice 7: transport-independent synchronization profile v3

Status: implemented behind the disabled HC-2 boundary. There is no production
entrypoint, feature flag, UI, watcher, timer, worker, network transport, or
background continuation.

## Version boundary

V1 and the Slice 6 V2 five-kind payload union remain frozen. Admission remains
V2. Synchronization uses the separate
`patchmark/hc2/encrypted-synchronization/v3` profile, schema/envelope version 3,
and V3-only hash, signature, HPKE-info, identity, parser, and negotiation
domains. Unknown, substituted, or mixed versions fail closed. No migration is
needed while production collaboration is disabled.

The V3 union is closed over the encrypted manifest, offer, inventory page,
object request, object response, confirmation, HC-1 chunk, and the three
strictly wrapped portable attachment forms. Every synchronization control
payload has `authority: "none"`. It cannot accept an event, change membership,
rotate an epoch, choose a fork, resolve a conflict, adopt a revision, compact
history, or bypass HC-1 validation.

## Planner and adapter boundary

`sync-planner.ts` is deterministic and synchronous. It receives verified
snapshot/message values and returns comparisons, bounded requests, response
selections, convergence classifications, or session transitions. It imports no
filesystem, IndexedDB, OPFS, Web Locks, cryptographic provider, randomness,
network, timer, worker, UI, or HC-1 mutation-authority API.

The remaining responsibilities are separate:

- `sync-inventory.ts` reads only an injected committed-portable-record source,
  reopens and revalidates exact bytes, and checks the durable generation before
  and after the read.
- `transport-v3-contracts.ts`, `transport-v3-crypto.ts`, and the V3 HPKE provider
  encode, sign, encrypt, authenticate, and version-bind messages.
- `transport-v3-framing.ts` and `sync-manual-adapter.ts` implement the explicit
  bounded portable-file adapter.
- `sync-session-store.ts` supplies in-memory and injected IndexedDB CAS journals
  for exact resume. Journals contain no private key or epoch secret.

All entrypoints are explicitly invoked and return after one bounded unit of
work. There is no hidden retry or continuation.

## Inventory trust model

The complete inventory comes from structurally valid, committed, project-owned
portable bytes. It includes the HC-1 immutable families, dependency-retryable
and authority-quarantined portable evidence, checkpoints, state/snapshot
objects, acknowledgements, and committed Slice 5/6 attachments. A descriptor
binds storage family, kind, strict identity, SHA-256 of reopened bytes, and
exact byte length.

Staging, incomplete batches, permanently corrupt records, recovery kits,
private keys, wrapped epoch custody, paths/handles, IndexedDB journals, OPFS,
indexes/caches, UI/editor state, diagnostics, and synchronization messages are
excluded. Index or OPFS corruption cannot add an accepted inventory object.
Duplicate identities with different bytes are corruption evidence and abort
snapshot creation.

Descriptors use ASCII family/kind/identity ordering. Greedy pagination is
deterministic under a maximum of 128 descriptors and 1 MiB of canonical
descriptor bytes per page; a negotiated test limit may be smaller, never
larger. Pages bind the session, round, snapshot, ordinal/count, boundaries,
descriptor count/list, and digest. Only a complete dense page set that
reproduces the total descriptor count and inventory root establishes remote
inventory completeness. Full-manifest/page reconciliation costs linear
descriptor disclosure and comparison inside the encrypted recipient container;
it is chosen for auditability and exact resume over probabilistic summaries.

A snapshot binds the project, stable portable generation, accepted control
head, current epoch and commitment, semantic frontier, checkpoint, projection
root, descriptor/page counts, inventory root, and protocol/reducer versions.
Writes after the two-generation read are left for a later explicit round.

## Offers, requests, responses, and confirmation

An offer is an encrypted signed statement of the sender's snapshot and limits,
not proof that the inventory is complete or accepted. Exact replay is
idempotent; another commitment at the same session message slot is a fork.

Requests are sorted, recipient-specific, encrypted, snapshot-bound, and capped
by object and byte budgets. Before responding, the sender must reopen and
verify every requested record, confirm project ownership and offered-snapshot
membership, recompute exact digest/length and required dependency closure, and
apply all limits. Cross-project, private, staging, invalid, or unoffered data is
therefore not addressable through the request. Requests never obligate a
response or create authority.

Responses bind the exact request and both snapshots. HC-1 records retain exact
persisted bytes, dependency-first closure, and deterministic chunking; portable
attachments retain their existing independent parsers. A short response must
declare exact unavailability/staleness or a bounded continuation. Silent
omission is invalid.

Confirmation uses a fresh verified inventory and separately binds accepted
semantic/control sets, frontier/head, authority and epoch state, canonical
projection, revision heads, conflicts, tombstones, reducer rejections,
component/composite roots, checkpoint/shared-state commitments, and
acknowledgement/receipt closure. Equal inventory alone is insufficient.
Convergence may legitimately contain the same explicit semantic/control fork
or reducer conflict on both devices; arrival order never chooses a winner.
Synchronization messages are excluded from portable inventory, preventing
confirmation ping-pong. A checkpoint acknowledgement is exchanged only when
the accepted checkpoint requires it.

## Privacy and cryptographic ordering

ADR-012 is preserved. The only public V3 fields are magic, version, suite,
exact HPKE `enc`, opaque envelope identity, opaque routing tag, ordinal, count,
and ciphertext length. The complete canonical header is HPKE AAD. Project,
people, memberships, devices, control/epoch state, purpose, session, inventory,
request, stream, and payload meaning remain inside sender-signed ciphertext.
There is no plaintext manifest, synchronization file, or sidecar.

Before any random, signing, HPKE, or ciphertext operation, injected accepted
authority must re-resolve active sender/recipient devices, their accepted keys,
transport capability, unambiguous control state, and available matching epoch.
Revocation, control change, or epoch change returns a typed stale/revoked result
with zero cryptographic calls. Each container uses a fresh single-use HPKE
context; no compression is permitted.

## Continuity, replay, stale state, and atomicity

Transport continuity classifies exact replay, retryable predecessor gap, and
same-position/wrong-predecessor forks without choosing by time, filename,
filesystem order, or tab. Session slots similarly distinguish identical replay
from conflicting signed bytes. Missing pages/responses return `more_required`;
abandoned or unknown-generation messages fail closed.

The device-private CAS journal retains exact session/generation, peer and bound
state, page/request progress, exact sent/received V3 bytes or one durable
reference, transport high-water evidence, bounded counters, and terminal
classification. Retrying an outbound slot reuses its exact immutable bytes.
No plaintext epoch secret or private key enters the journal.

Inbound containers are completely framed, decrypted, authenticated, signed,
manifest/session/request checked, and independently object-verified before the
injected existing HC-1/Slice-6 importer stages a combined batch. Dependency and
authority verification precede the complete batch marker written last.
Storage is reopened and reconstructed before inbound stream/session CAS is
finalized. Invalid input exposes no partial subset; exact present records are
idempotent, and valid evidence may remain quarantined under unchanged HC-1
rules.

## Explicit progress limits

One caller invocation processes at most:

- 4 inventory pages and 4 request pages;
- 64 requested or returned objects;
- 16 MiB of response object bytes;
- 64 MiB read and 64 MiB written;
- 16 decrypted containers;
- dependency depth 256;
- 16 messages;
- 32 session rounds.

These sit below the existing 16 MiB object, 18 MiB signed-record/container,
256 MiB portable-bundle, 1,024 object/chunk, and 4,096 container limits. Budget
exhaustion returns `more_required` with deterministic next work. Recursion,
automatic retry, timers, polling, watched folders, and background workers are
not used.

## Limits and deferrals

Physical possession of a portable folder or exported ciphertext remains a
security boundary. Revocation prevents new export but cannot recall ciphertext
delivered before revocation. Admission remains the only supported incomplete
pre-admission-history boundary.

Network/relay transport, background synchronization, monitored folders,
automatic scheduling, production UI, pruning/compaction, and production
enablement remain deferred. The V3 adapter is transport-independent, but Slice
7 ships only the explicitly injected manual-file test adapter.

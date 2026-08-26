# HC-3 Slice 3: manually signaled direct V3 transport

Status: disabled qualification surface only
Protocol authority: none
Transport adapter: `manual-webrtc-datachannel`, version 1

## Boundary

Slice 3 adds an explicitly invoked, manually signaled peer byte channel. It is
not imported by Patchmark's production collaboration barrel, has no route or
automatic startup, and registers no signaling or synchronization service.
There are no STUN, TURN, relay, WebSocket, HTTP synchronization, polling,
discovery, reconnect, or background-retry paths. The qualification factory
constructs the browser peer object with exactly `{ iceServers: [] }`.

The direct adapter transports exact encrypted V3 bundle bytes. It does not
plan synchronization, select objects, decrypt containers, import objects, or
resolve conflicts. Those operations remain owned by HC-2 V3 journals,
planners, cryptographic providers, the HC-1 stores, projector, roots,
consolidation, and checkpoint implementation. The encrypted-file workflow
remains available without regenerating already committed V3 bytes.

## Manual connection protocol

One side explicitly creates an offer and waits for non-trickle local candidate
gathering to complete. The resulting strict adapter-owned description is put
inside the existing Slice 1 connection carrier. A separate authority-free
authenticated record binds the exact carrier bytes to:

- project and V3 session identity/generation;
- a fresh 16-byte connection-attempt identity;
- initiating and responding accepted device identities;
- accepted control head and current epoch identity/commitment;
- adapter identity/version; and
- accepted signer key identity and Ed25519 signature.

The response contains both the Slice 1 offer-carrier commitment and a SHA-256
commitment to the complete signed offer record. It therefore cannot be moved
to another project, peer, session, generation, adapter, attempt, control head,
epoch, or offer. Offer and response verification resolves the signer through
current accepted control state. Current device, control-head, and epoch
evidence is re-read before peer construction and before V3 preparation, send,
and import boundaries. Revocation or rotation stops the attempt; transport
records never grant authority.

The manual text uses a canonical Base64url/checksum envelope. Copy is always
available. Link and single-QR presentation are allowed only when the actual
text fits the frozen Slice 1 limits; otherwise the workflow explains the exact
copy fallback. Real Chrome qualification records the actual SDP, description,
and text sizes rather than assuming they fit.

Connection artifacts necessarily expose transport metadata to the person who
receives them: opaque project/session/device/key identifiers, accepted control
and epoch identifiers, adapter/version, attempt identity, SDP fingerprints,
host candidates selected by the browser, byte lengths, and signatures. They do
not contain document content, epoch plaintext, private keys, V3 plaintext, or
authority grants. The encrypted V3 channel still exposes traffic timing and
sizes to endpoints and the local network.

## Channel and framing profile

The adapter creates one in-band data channel with fixed label
`patchmark-hc3-v3`, subprotocol `patchmark/hc3/direct-v3/v1`, ordered delivery,
and default reliable retransmission. It sets `binaryType = "arraybuffer"` and
rejects non-binary messages. Browser capabilities are injected; module import
does not read browser globals.

Each frame is exact-field canonical CBOR and binds the connection attempt,
transfer identity, exact transfer length, SHA-256, ordinal/count, byte offset,
and payload. Payloads are at most 4,096 bytes, below the required 16 KiB
ceiling. Frame sets must be dense and non-overlapping. Byte-identical
duplicates are idempotent; conflicting duplicates, gaps, impossible counts,
wrong attempts, trailing bytes, and digest mismatches fail closed. Transfers
are bounded at 256 MiB and 65,536 frames. The exact metadata boundary is
tested without allocating the maximum transfer, and `+1` is rejected.

The sender copies every outbound frame. It uses actual `bufferedAmount`, a
fixed high/low watermark, and `bufferedamountlow` events. It does not poll.
Cancellation and close clear partial assembly, pending receivers, and all
message/close/backpressure listeners.

Offer creation, remote-description application, answer creation/application,
candidate gathering, and channel opening run through an injected deadline
port. Expiry closes the peer object; the disabled workflow reports an ordinary
interrupted state with explicit fresh-attempt and encrypted-file actions.

## Interruption, retry, and collision rules

Peer descriptions, channels, and partial frame assembly are ephemeral. A
restart requires a new attempt identity, new offer/answer, and new browser peer
objects. The existing durable V3 journal remains authoritative, so an
interrupted committed bundle is resent byte-for-byte. There is no automatic
reconnect. If both people create offers, the ordinary workflow state is “Both
people created requests”; it names no automatic winner and requires one side
to cancel and start a fresh attempt.

## Qualification evidence

The focused Node test covers strict parsing, signatures, current-authority
checks, exact offer binding, frame boundaries, reorder/duplicate/conflict
behavior, real event-based backpressure through linked binary ports, cleanup,
and ordinary workflow states. A compact frozen fixture describes rather than
stores its 10,003 payload bytes. An independent Python stdlib verifier imports
no Patchmark code and reproduces all frozen CBOR lengths and SHA-256 values.

The primary Chrome test launches two isolated persisted profiles and reuses
the HC-2 custody and V3 browser runtimes. It manually transfers authenticated
offer and response text through the test driver, then sends only exact V3
bundle bytes over the real peer channel. It creates concurrent accepted work,
exercises multi-frame backpressure, interrupts a three-frame V3 response,
creates a fresh connection, resumes from durable V3 bytes, converges through
conflict resolution and acknowledgements, verifies zero-object final rounds,
closes both profiles, and reopens the authoritative and projected state from
portable/IndexedDB continuity. Device B retains
`full_history_verified: false` at its admission boundary.

## Connectivity limits, threat model, and deferrals

With an empty ICE-server list, qualification is deliberately limited to paths
the browsers can establish from host candidates. NAT, carrier NAT, restrictive
firewalls, enterprise policy, address-family mismatch, host-candidate privacy
behavior, or browser policy can make the direct path unavailable. Failure is
an ordinary state and the encrypted-file path remains the supported fallback.
Chrome qualification is evidence only for the exact reported Chrome version;
it does not infer support for Safari, Firefox, Edge, older Chromium, mobile
browsers, or different networks.

The threat model assumes attackers can copy, replay, reorder, truncate, or
modify manual artifacts and frames, and that a previously accepted device may
later be revoked. Exact signatures, offer commitments, current-authority
checks, attempt binding, canonical framing, bounds, and V3 authenticated
encryption fail these cases closed. Residual risks include endpoint compromise,
metadata disclosure listed above, denial of service, manual artifact delivery
to the wrong person before validation, delivered-ciphertext retention after
revocation, unavailable host connectivity, and platform peer-stack defects.

STUN, TURN, relays, discovery, signaling services, connectivity negotiation,
network fallback, automated synchronization planning, and production workflow
integration are explicitly deferred. A later slice must re-evaluate their
privacy, abuse, operational, and authority consequences rather than enabling
them through this adapter.

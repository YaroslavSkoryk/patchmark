# HC-3 Slice 1: self-contained handoff and no-cloud connection architecture

Status: implemented as disabled, environment-neutral contracts and test evidence

Version: HC-3 carrier/text v1

Production collaboration enabled: **no**

## Product and no-cloud decision

Patchmark handoffs are self-contained artifacts. A user may copy one, put it in
a URL fragment, show its exact text as a QR code, or save existing encrypted
HC-2 bundle bytes as a file. No account, Patchmark cloud project database,
global lookup service, mandatory relay, or mandatory signaling service is part
of this architecture. A short server-backed lookup code is explicitly not
implemented or described as self-contained.

Opening or parsing an artifact only proves that its representation is
well-formed. It never admits a member, accepts a device, imports an object,
advances a stream, changes project state, or grants authority. Existing HC-2
invitation, possession-proof, owner authorization, membership, epoch,
signature, CAS, V2 import, and V3 synchronization remain authoritative.

The [HC-2 final audit](../hc2/final-security-architecture-audit.md) remains the
governing foundation. HC-3 does not change its protocols or frozen fixtures.

## Existing HC-2 contracts reused

| Workflow need | Exact reused contract/path | HC-3 behavior |
| --- | --- | --- |
| Invitation handoff | `InvitationHandoffCore` and accepted invitation evidence | Carries the exact canonical handoff bytes; parsing does not consume the invitation |
| Candidate response | `EnrollmentRequestRecord` with Ed25519 signature and public Ed25519/X25519 keys | Carries the exact canonical signed request bytes |
| Possession response | `PossessionProofRecord` and the existing encrypted challenge ceremony | Carries the exact canonical proof bytes; owner verification and challenge CAS remain HC-2 |
| Candidate admission | Candidate admission, membership transition, epoch delivery, and receipt contracts | No duplicate carrier admission protocol; V2 continues to perform admission |
| V2 manual exchange | V2 public header, encrypted-container record, canonical bundle framing, stream journal, import backend, and receipt | File bytes remain the exact canonical V2 array |
| V3 synchronization | V3 session/stream identities, offer/inventory/request/response/confirmation messages, planner, crypto, framing, and manual adapter | Direct byte channels and files both transport unchanged V3 |
| Routing/session continuity | Opaque routing tags, session IDs/generation, stream IDs/generation, bundle sequence, predecessor, journals, and CAS | Carrier metadata cannot replace any continuity check |
| Planner output | Existing `authority: "none"` V3 inventory/planner records | Carrier parsing cannot promote a plan to accepted evidence |
| Qualification | Explicit manual adapters and two-profile qualification | Slice 1 adds representations only; no workflow or production adapter |

## Carrier-versus-authority boundary

Every HC-3 carrier is versioned, exact-field parsed, bounded, canonically CBOR
encoded, nominally typed, and contains literal `authority: "none"`. The HC-3
namespace is absent from the production collaboration barrel.

The valid interpretation is:

> This is a well-formed handoff artifact that may be submitted to the existing
> authoritative workflow.

It is never:

> The invitation, member, device, session, bundle, event, or project change is
> accepted.

Handoff carriers contain `payload_protocol: "hc2"`,
`payload_encoding: "canonical_cbor"`, and an exact byte string. Creation first
passes the supplied object through its existing HC-2 parser. Decoding checks
canonical CBOR, parses through the same HC-2 parser, and requires byte-for-byte
canonical re-encoding equality. Unknown fields, versions, kinds, and
cross-family substitutions fail.

The carrier layer has no storage, filesystem, browser, network, timer, worker,
UI, randomness, key, signing, encryption, or decryption capability. V2/V3 file
inspection accepts an injected incremental hash implementation only because it
reuses the existing bounded framing readers; it has no import backend and
cannot commit data.

## Artifact taxonomy

| Artifact | New representation | Authority and next action |
| --- | --- | --- |
| Invitation handoff | HC-3 carrier enclosing exact `InvitationHandoffCore` bytes | Submit to existing enrollment workflow; no admission |
| Enrollment request | HC-3 carrier enclosing exact `EnrollmentRequestRecord` bytes | Verify candidate signature and begin existing possession ceremony |
| Possession proof | HC-3 carrier enclosing exact `PossessionProofRecord` bytes | Verify stored challenge, key possession, control head, and owner authority |
| Connection offer | HC-3 carrier with opaque V3 session binding and adapter-owned bytes | Future adapter attempts a byte channel; no session authority |
| Connection answer | Same session/generation and adapter tag, plus SHA-256 commitment to the exact offer preimage | Verify offer/answer binding before a future transport attempt |
| V2 admission file | Exact canonical V2 encrypted bundle bytes | Existing authenticated atomic V2 import only |
| V3 synchronization file | Exact canonical V3 encrypted bundle bytes | Existing authenticated atomic V3 import only |

No V1, V2, or V3 contract changes, and no V4 protocol exists.

## Connection offer and answer

Offer and answer carriers contain only:

- carrier version, kind, and `authority: "none"`;
- an opaque existing V3 synchronization session ID and uint64 generation;
- a 1–32-byte adapter-owned opaque tag;
- 1–1,536 opaque transport-description bytes; and
- for an answer only, the 32-byte SHA-256 commitment to the exact offer.

The offer commitment preimage is canonical CBOR of:

```text
[
  "patchmark/hc3/connection-offer-commitment/v1",
  <exact parsed connection-offer carrier>
]
```

HC-3 constructs and brands this preimage but performs no hashing itself. The
answer must match the offer session, generation, adapter tag, and computed
commitment. This prevents an answer from being silently paired with a different
offer. It does not authenticate the peer or create project authority. Future
adapters must bind the established channel to accepted HC-2 device evidence
before V3 exchange.

Transport descriptions are opaque and adapter-owned. HC-3 does not freeze SDP,
ICE candidates, IP addresses, browser strings, candidate ordering, or a WebRTC
enumeration into the collaboration protocol.

## Canonical text

The single text form is:

```text
pmhc3.v1.<kind>.<unpadded-base64url-canonical-carrier>.<crc32c>
```

Kinds are `ih`, `er`, `pp`, `co`, and `ca`. The fixed prefix, version, kind,
and CRC-32C are lowercase. Base64url payload letters are case-sensitive. Only
ASCII letters, digits, period, underscore, and hyphen are accepted; padding,
whitespace, escapes, Unicode confusables, duplicate prefixes, trailing fields,
and noncanonical alternatives fail.

The decoder calculates the decoded length before allocating, performs strict
unpadded Base64url decoding, decodes canonical CBOR, checks the kind twice, and
requires exact text re-encoding equality. CRC-32C detects accidental corruption
only. It is not authentication. Authentication comes from the enclosed HC-2
signatures, encrypted container, accepted control state, and CAS when the
artifact reaches the authoritative workflow.

This representation is self-contained but not a “short code.” A genuinely
short global code would require storage or rendezvous infrastructure.

## Fragment links

Links are pure adapters around canonical text:

```text
https://<injected-origin-and-path>#<canonical-HC-3-text>
```

The HTTPS base is injected and is not part of artifact identity. Creation and
parsing perform no navigation, fetch, DNS lookup, history mutation, storage,
dynamic import, clipboard, or share-sheet action. Parsing requires one fragment,
an exact expected base, no query, no credentials, no percent-escaped payload,
and no payload in the path.

Fragments are not secrets. Browser history, screenshots, clipboard managers,
messengers, extensions, link previews on a recipient device, or the sharing
channel may expose them. Patchmark must present that limitation before sharing.

## QR representation

A QR code is only a visual rendering of the exact canonical text. Slice 1
defines a conservative single-symbol character decision and adds no renderer,
camera access, scanner, compression, fragmentation, or dependency.

- Maximum: 2,953 ASCII characters.
- Exact boundary is eligible; 2,954 is not.
- Oversized artifacts fall back to copy/share or an encrypted file.
- No truncation, compression, or multi-symbol fragmentation is permitted.
- QR presentation adds neither authentication nor authority.

## Encrypted bundle files

V2 and V3 bundle files retain their exact canonical encrypted bytes. HC-3 does
not wrap them in JSON, Base64, text, or another bundle protocol.

- Extension: `.pmcb`
- Media type: `application/vnd.patchmark.collaboration-bundle`
- Filename: `patchmark-<lowercase full SHA-256 hex>.pmcb`
- Maximum exact bytes: the existing HC-2 256 MiB portable-bundle bound

The filename is deterministic and opaque, and contains no project or person
name. It exposes the file digest and is operational metadata only. Extension,
media type, path, OS handle, permission, selection, and share state never select
a protocol version or create authority.

Inspection bounds the original byte array before a framing reader can copy it,
then validates the exact canonical V2 or V3 encrypted-container array. A file
that is truncated, appended, mixed-version, oversized, malformed, or unsupported
fails. Outer inspection identifies versioned structure; the public header is
authenticated as AAD only during the existing HC-2 open/import. Selection and
inspection do not decrypt, stage, commit, or make anything visible. Existing
atomic import remains the only acceptance path and retains duplicate
idempotency, recipient/project/session bindings, continuity checks, and
commit-marker-last visibility.

## Exact limits and measured vectors

| Layer | Limit |
| --- | ---: |
| Invitation HC-2 payload | 16 KiB canonical bytes |
| Enrollment/proof HC-2 payload | 64 KiB canonical bytes |
| Opaque connection description | 1,536 bytes |
| Opaque adapter tag | 32 bytes |
| Complete HC-3 carrier | 69,632 canonical bytes |
| Copyable canonical text | 93,000 characters |
| Link fragment payload | 16,384 characters |
| Injected base URL | 2,048 characters |
| Complete link | 18,432 characters |
| Single QR | 2,953 characters |
| Encrypted V2/V3 file | 256 MiB exact canonical bytes |

Measured focused artifacts:

| Artifact | Carrier bytes | Canonical text characters | Single QR |
| --- | ---: | ---: | --- |
| Frozen invitation | 651 | 889 | eligible |
| Focused enrollment request | — | 2,381 | eligible |
| Focused possession proof | — | 1,719 | eligible |
| Frozen connection offer | 320 | 448 | eligible |
| Frozen connection answer | 355 | 495 | eligible |
| Focused one-container V2 file | 585 exact file bytes | not text | ineligible |
| Focused one-container V3 file | 586 exact file bytes | not text | ineligible |

The copyable-text ceiling permits bounded diagnostic/test representations; the
link and QR limits are deliberately smaller. Product code must offer the next
appropriate carrier rather than silently changing an artifact.

## Visible metadata and privacy

Canonical text visibly exposes its HC-3 version and artifact-kind tag. Base64url
is encoding, not encryption. Decoding an invitation exposes the existing opaque
project, invitation, invitation-evidence, and accepted-control identifiers,
intended role, project-wide scope, and crypto suite. Enrollment artifacts also
contain public keys, signed nonces/challenge evidence, and opaque membership,
person, and device identifiers already required by HC-2. They contain no private
key, epoch plaintext, recovery material, document content, project/document
name, private path, handle, bookmark, editor state, or diagnostic record.

Connection carriers expose an opaque V3 session ID/generation, adapter tag,
description length, and the adapter description itself. A future network
description may reveal IP, interface, or candidate metadata to the peer or
sharing channel; HC-3 does not claim otherwise. Encrypted files expose file
size, timing, full file digest in the canonical filename, container count, and
opaque public-header routing fields. Authentication hides neither all metadata
nor traffic shape.

## Replay and lifecycle

- Parsing the same carrier or text repeatedly is harmless and has no state.
- Reopening the same invitation does not bypass `Hc2EnrollmentStore` CAS.
  An exact terminal retry is idempotent; a distinct second consumption fails.
- Reusing an offer or answer cannot create an authoritative second session.
  The answer binds the exact offer, and V3 session/stream journals remain the
  authority-free continuity mechanism before accepted import.
- Re-importing an exact V2/V3 bundle retains existing idempotency.
- Wrong recipient, project, session, predecessor, control head, epoch, revoked
  device, stale replay, gap, or same-position fork remains rejected by HC-2.
- No carrier timestamp or local clock participates in authority. Slice 1 adds no
  timestamp or expiry field.

## Honest future direct-connection sequence

1. An admitted device prepares an authenticated HC-2 context and a
   non-authoritative HC-3 connection offer.
2. The user sends it by copy, fragment link, QR, or a user-selected file/channel.
3. The recipient validates it locally and creates an answer bound to the offer.
4. The answer returns through the same or another user-selected channel.
5. A future reviewed adapter attempts local-network or peer-to-peer connectivity.
6. After a byte channel exists and peer binding succeeds, unchanged V3 runs.
7. If direct connectivity fails, Patchmark offers encrypted V3 file export/import.

A one-way link cannot complete remote peer-to-peer signaling without a
rendezvous service. Both users may need to be present. NAT or firewalls may
prevent a direct connection. Patchmark must not silently route through a
centralized relay. A user-controlled or self-hosted adapter requires a separate
architecture and security review. Direct connectivity changes transportation,
never project authority.

## Future user-facing state model

Future UI should use ordinary language and keep secret-free technical details in
a separate diagnostics surface:

- **Invite collaborator**
- **Copy invitation link**
- **Show invitation QR**
- **Open invitation**
- **Send response**
- **Sync now**
- **Copy connection link**
- **Show connection QR**
- **Send encrypted update**
- **Open encrypted update**
- **Waiting for response**
- **Direct connection unavailable**
- **Verification failed**
- **Changes synchronized**
- **Conflict needs resolution**

Slice 1 implements none of this UI.

## Threat model

| Threat | Prevention/detection | Residual risk and recovery |
| --- | --- | --- |
| Malicious or substituted carrier | Canonical bytes, exact kind, CRC accidental check, answer commitment, existing HC-2 signature/recipient/project/session verification | CRC is not authentication; reject at HC-2 and obtain artifact through another channel |
| Cross-family substitution | Text tag, carrier kind, record kind, and HC-2 payload parser must agree | Denial or repeated invalid shares remains possible |
| Corruption, whitespace, confusable, escape, padding, or trailing data | Strict ASCII grammar, unpadded Base64url, CRC-32C, canonical re-encoding | User must recopy/rescan the exact artifact |
| Oversized text/QR/file | Length checked before decoding/copying; QR +1 falls back without truncation | Valid maximum artifacts can still consume time/memory |
| Invitation replay | Existing accepted-control state and invitation CAS enforce single use | Exact retry remains visible as the same completed operation |
| Offer/answer replay or substitution | Session/generation/adapter equality and domain-separated offer commitment; V3 continuity remains authoritative | Sharing-channel denial and metadata observation remain possible |
| Truncated, appended, or mixed file | Existing canonical framing readers require one complete dense versioned array | User must select an intact encrypted file |
| Misleading filename/media type | Version comes from exact encrypted-container structure, then HC-2 authenticated import | OS may still display misleading names supplied by another party |
| Revoked or stale device | Existing outbound authority revalidation occurs before HC-2 cryptographic preparation | Previously delivered plaintext/ciphertext cannot be recalled |
| Compromised sharing channel | HC-2 signatures, HPKE, AAD, recipient routing, epoch, control, session, and continuity checks | Size/timing and connection metadata may leak; channel can withhold or duplicate |
| Compromised future signaling/adapter | Adapter never becomes authority; V3 remains authenticated | A separate adapter review and peer-binding design are mandatory |
| Import-time or production activation | Side-effect-free imports, production-lock scan, absent production imports/routes/handlers/flags | Future integration requires a new explicit review |

## Known limitations

- Text and QR invitation/enrollment artifacts are not confidential.
- QR reliability may be lower than the theoretical character ceiling on poor
  cameras, screens, printing, or error-correction settings; rendering remains
  deferred.
- CRC-32C handles accidental corruption only.
- Connection metadata may disclose network information once an adapter exists.
- A direct connection may be impossible behind NAT or restrictive firewalls.
- Manual exchange requires user presence and may involve multiple round trips.
- Maximum-size canonical text and 256 MiB files can be expensive despite bounds.
- Chrome 151 is the only browser exercised for the new frozen vectors.
- No UI, camera, clipboard, share sheet, filesystem picker, protocol handler,
  connection adapter, or networking implementation exists.

## Deferred implementation work

HC-3 Slice 2 may build a disabled explicit workflow facade and adapter ports for
copy, QR presentation, share sheet, and file selection without adding authority.
It must integrate real invitation/enrollment lifecycle feedback, verify offer
commitments before adapter use, and retain encrypted V3 file fallback. Actual QR
rendering/scanning, filesystem UI, direct networking, LAN discovery, WebRTC,
signaling, rendezvous, relay, and production enablement each require their own
bounded design, privacy analysis, tests, and security review.

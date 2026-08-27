# HC-3 Slice 5 external browser and physical-device protocol

## Evidence available locally

The local host is Apple silicon macOS 26.2 (build 25C56). Google Chrome
151.0.7922.174 is installed and is the only engine exercised by the automated
integrated suites. Safari 26.2 (21623.1.14.11.9) is installed, but a bounded
WebDriver session attempt returned: “Allow remote automation” must be enabled
in Safari Settings. The setting was not changed by this slice, so Safari is
`not_exercised`. Firefox and Edge are not installed.

The device inventory reported a paired iPhone 15 as unavailable. A paired
Apple Watch was available but is not a Patchmark target. No physical camera,
OS share sheet, mobile filesystem, mobile key custody, or real cross-device
network was exercised. Emulated viewports are not physical-device evidence.

## Targets

Before production enablement, run this protocol on every explicitly supported
desktop browser/version floor, iOS Safari device/OS floor, and Android Chrome
device/OS floor. Edge and Firefox require their own evidence if claimed;
Chromium evidence is not Edge evidence, and WebKit evidence is not Safari
evidence. Do not infer older or mobile versions from a current desktop build.

## Preparation

1. Record OS, hardware, browser full version, engine, headed/headless mode,
   network topology, camera model, available storage, and whether the profile
   is new or reopened.
2. Build from a reviewed commit. Record the commit, dependency-lock SHA-256,
   all frozen fixture SHA-256 values, production build ID, and readiness-matrix
   SHA-256.
3. Use two isolated browser profiles and two non-sensitive synthetic project
   folders. Record source-folder hashes before any operation.
4. Confirm production remains disabled. Use only the separately approved
   development qualification entry; do not alter the production gate.
5. Disable extensions and unrelated synchronization. Do not use a public STUN,
   TURN, relay, rendezvous, signaling, telemetry, or remote-error service.

## Required workflow evidence

Run setup, recovery-kit save/reopen/challenge, invitation, QR Copy/Share
equivalence, response, possession, admission, concurrent mutations, manual
offer/answer, direct V3 transfer with `iceServers: []`, reversed bundle arrival,
conflict resolution, encrypted-file fallback, revocation, receipt closure,
reload, project switching, and portable reopen. Compare authoritative objects,
exact bytes, semantic/control sets, frontiers, authority, epoch, projection,
revision heads, conflict cores, tombstones, reducer rejections, five roots,
composite root, checkpoint, state blob, snapshot, acknowledgements, and
receipts. The newly admitted device must retain `full_history_verified: false`.

Capture offer and answer UTF-8 sizes, exact V3 SHA-256 values, encrypted-file
SHA-256 values, transfer rounds, fallbacks used, and blocked/degraded
operations. Never put full artifacts, project plaintext, recovery material,
private keys, camera frames, or absolute local paths in evidence.

## Capability and lifecycle matrix

For each target, exercise—not merely detect—IndexedDB, non-extractable key
persistence/reopen, required WebCrypto algorithms, Web Locks and contention,
OPFS, File System Access, copy, text/file share, file open/save, download/upload
fallback, QR render, native/image QR scan, camera denial/dismissal/track end,
WebRTC, background/foreground, orientation, reload after each durable cut,
project switch during a capability, duplicate confirmation, and stale-dialog
rejection. Block the target if non-extractable custody does not survive reopen.

On physical mobile devices also test narrow viewport, touch targets, 200% text
or platform zoom, screen reader, OS share sheet, file-provider round trip,
real screen-to-camera QR scanning, memory-pressure interruption, network
transition, and encrypted-file fallback. Simulator results may supplement but
cannot pass camera, share sheet, custody, local files, or real network rows.

## Security-policy and abuse evidence

Exercise the actual integrated UI under the approved non-eval CSP and Trusted
Types profile. Collect directive names and redacted sink categories only.
Then repeat oversized, wrong-kind, replayed, cross-project, cross-session,
revoked, delayed, reordered, duplicated, truncated, flood, simultaneous-offer,
Unicode/bidi-label, double-event, and corrupt-presentation cases. Accepted
authority and pending V3 bytes must remain unchanged on every rejection.

## Artifacts and pass rules

Required evidence is a signed manifest containing hashes, structured test
results, browser capability output, redacted policy violations, and cleanup
results. Screenshots may show ordinary UI state but must not contain complete
artifacts or project content. Logs use typed codes, sizes, and hashes only.

A platform is `supported` only if the complete authority workflow, custody
reopen, direct or documented fallback path, durable reopen, security-policy
profile, accessibility checks, and cleanup pass. It is `degraded` only when a
tested fallback preserves all authority/security semantics. It is `blocked`
for missing custody, cryptography, durable storage, safe fallback, or any
validation weakening. Missing evidence is `not_exercised`.

Delete profiles, projects, downloads, screenshots containing artifacts,
camera images, test databases, servers, peer connections, channels, workers,
timers, object URLs, and build output after hashes are recorded.

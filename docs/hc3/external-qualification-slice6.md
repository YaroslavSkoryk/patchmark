# HC-3 Slice 6 external qualification package and device protocol

Status: test-only, authority-free, local-network-only

## Runner architecture

`npm run qualify:collaboration-hc3-external` builds the same production-
optimized test application and real product authority runtime qualified in
Slice 5, then serves owner and candidate paths on loopback port 3140. To use an
explicitly trusted local network, invoke the script directly with `--host
0.0.0.0`; never expose the listener through port forwarding or a public host.
The runner has no production route, upload, telemetry, remote signaling,
account, cloud database, STUN, TURN, relay, discovery, watcher or retry.

The page displays a random evidence-session identifier before the synthetic
workspace. Browser-reported capabilities, exact artifact byte counts and
SHA-256 commitments, assertion mode, permission outcomes, policy status,
authority-equality commitments and cleanup state can be exported as JSON.
Artifact bytes, private keys, recovery material, project text, camera frames
and absolute paths are forbidden. The strict parser rejects unknown fields,
wrong record kind, any authority other than `none`, non-synthetic records,
bad hashes, oversized arrays/records, complete carriers, secret markers and
absolute user paths. Imported evidence is a qualification record only and is
never accepted as project authority.

The template is
`scripts/fixtures/collaboration-hc3-slice6-qualification-template.json`.
Automated and manual assertions are separate. The template and browser-
reported availability are `not_exercised`, not passes. A downloaded record is
complete only after a human records the exact browser/engine/OS/device,
exercised results, final authority commitments and cleanup confirmation.

## Common two-device procedure

1. Build from a reviewed commit. Record the commit, lockfile hash, readiness
   manifest hash, all fixture hashes and evidence-session ID.
2. Create two isolated browser profiles. Use only the runner's synthetic owner
   and candidate projects. Record browser, engine, OS, model, mode and network.
3. Confirm the normal production application still has no Collaboration item,
   DOM, route, dynamic import, IndexedDB or capability activity.
4. Open the test-only owner and candidate paths. Confirm no authority runtime
   exists before pressing the explicit open button.
5. Through the real UI, create a collaboration copy, create/save/reopen and
   challenge recovery material, invite, render and scan QR, create the response,
   prove possession, admit with V2, and return the receipt.
6. Create genuinely concurrent semantic mutations without causal observation.
   Exchange explicit dependency-closed V3 bundles in both directions, repeat
   reversed arrival, exchange acknowledgement/receipt closure, reconstruct the
   same conflict and resolve it through reviewer/owner authority.
7. Establish direct WebRTC using manual offer/answer and `iceServers: []`.
   Record UTF-8 offer/answer sizes, connection outcome and network topology.
   Interrupt once. Do not retry automatically. Exercise exact encrypted-file
   fallback and record each file size and SHA-256.
8. Revoke the candidate, rotate epoch, prove post-cutoff rejection before
   cryptography/persistence, and explain that received data cannot be recalled.
9. Close both profiles completely. Restart the browser. Reopen exclusively from
   portable storage and IndexedDB custody. Compare accepted object IDs/bytes,
   semantic/control sets, frontiers, authority, epoch, projection bytes,
   revision heads, conflict cores, tombstones, reducer rejections, five roots,
   composite root, checkpoint/payload, state blob, snapshot, acknowledgements
   and receipts. Candidate history remains `full_history_verified: false`.
10. Exercise keyboard, focus, live regions, 200% zoom, 390×844 layout, long
    strings, forced colors, reduced motion, QR alternative, camera/file
    fallback, technical disclosure, error recovery and project switching.
11. Export one authority-free record per device. Compare commitments without
    putting project bytes in the evidence. Mark human observations `manual`.
12. Delete synthetic projects, profiles, downloaded artifacts, QR images,
    screenshots, traces and evidence copies; stop camera tracks, peer
    connections, channels, workers, timers and the runner. Confirm cleanup.

## Safari 26.2 manual procedure

Use normal Safari; do not silently enable Remote Automation. Run the common
procedure headed. Exercise IndexedDB and both non-extractable key classes over
a full Safari quit/relaunch first; block Safari immediately if either key
cannot reopen. Exercise Web Locks/OPFS and Safari file controls using real
panels, clipboard denial/success, sharing where the OS exposes it, image QR,
camera QR, background/foreground, data-channel interruption and encrypted-file
fallback. Record CSP console/security events. Trusted Types is recorded only if
the actual Safari build implements it. Complete VoiceOver separately. Current
status: `not_exercised`.

## iOS Safari physical procedure

Use the physical iPhone, not a simulator or responsive desktop mode. Run in
portrait and landscape; verify 48 px-equivalent touch targets, keyboard
avoidance and 200% text. Exercise OS share sheet, clipboard permission, Files
open/save, live QR from another screen, image QR fallback and every camera
terminal path: success, denial, cancellation, error, background, navigation and
workspace close. Confirm tracks end in Web Inspector or the device camera
indicator. Generate both non-extractable key classes, fully terminate Safari,
restart and reopen. Exercise background/foreground, intended Wi-Fi, interrupted
direct connection, encrypted-file fallback, conflict, revocation, equality and
cleanup. Complete VoiceOver. Current status: `not_exercised`.

## Android Chrome physical procedure

Use a physical supported Android device and a fresh Chrome profile. Repeat the
common workflow in portrait/landscape with keyboard and 200% text, OS share
sheet, clipboard, Storage Access Framework open/save, camera QR from another
screen, image QR fallback, denial/cancellation/track loss, app background and
full Chrome restart. Prove non-extractable signing and HPKE custody after
restart, intended-network WebRTC with empty ICE servers, interrupted direct
connection, exact encrypted-file fallback, conflict, revocation, equality and
cleanup. Complete TalkBack. Current status: `not_exercised`.

## Evidence capture and failure rules

Capture a concise human summary plus the JSON record, browser/OS about-screen
version, permissions, artifact size/hash table, policy result, accessibility
notes and cleanup confirmation. Screenshots must not show complete artifacts or
project content. A capability is a pass only when exercised. A safe, actually
used fallback may be `conditional`; missing custody, cryptography, durable
storage, safe fallback or validation is `blocked`. Lack of a device, permission
or reviewer is `not_exercised`.

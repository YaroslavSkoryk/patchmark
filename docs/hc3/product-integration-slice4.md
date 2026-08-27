# HC-3 Slice 4: production-locked product qualification

Status: development qualification only
Production state: unconditionally disabled
Product entry: **File → Collaboration…** for an open project

## Integration and production lock

Slice 4 adds one project-level action to the existing File menu. It appears
only after the existing collaboration-shadow feature resolver accepts the
literal injected `development_shadow` state in a development or test build.
The same call returns the existing frozen disabled sentinel synchronously in
production. Production returns before a receipt factory, browser global,
dynamic import, React workspace, storage read, cryptography, randomness,
worker, timer, QR provider, peer connection, file port, or capability probe.

The editor reaches the gate through its existing `patchmark-project` import,
which already owns the sole collaboration-shadow production seam. The gate
then lazily imports `product-qualification-loader.ts`; only that accepted
loader reaches the workspace and its HC-2/HC-3 dependencies. There is no
collaboration route. Query parameters, fragments, cookies, local storage,
public environment values, browser extensions, and pasted artifacts are not
read by the feature resolver and cannot enable production collaboration.

When disabled, no menu item, hidden dialog, focus target, layout reservation,
project read, editor remount, receipt-factory call, dynamic import, or browser
capability work is added. The compact application bar remains 48 pixels high.

## Product workflow

The accessible modal workspace follows Patchmark's existing compact surface
and uses ordinary language. Its steps are:

1. **Set up collaboration** — choose a separate destination and invoke the
   existing HC-1 duplicate-current-state foundation. The source is never
   converted in place. Paths, handles, bookmarks, active-document and editor
   state, review overrides, and recovery material stay outside portable
   evidence. Completion requires reopen and projection/root verification.
2. **Recovery kit** — create, save, reopen, and pass the existing HC-2
   challenge before foundation completion is presented as successful.
3. **Invite collaborator** — choose an currently authorized project-wide
   role, create the real Invitation, and keep exact Copy, Share, QR, and text
   fallback presentations available. Opening an Invitation never grants
   access.
4. **Complete invitation** — paste, scan, or select an artifact; preview it
   without mutation; create the candidate's non-extractable keys and
   possession proofs; return the Response; revalidate the current invitation,
   control head, role, device, and epoch; then explicitly approve admission.
5. **Admission** — preview the opaque encrypted V2 file, confirm its local
   device intent, import through existing custody, reopen, verify, and return
   the receipt. The UI states: “Current state verified. Earlier collaboration
   history was not fully traversed at admission” when
   `full_history_verified` is false.
6. **Synchronize changes** — prefer **Connect directly**, then offer **Send
   encrypted update**. Direct request/response artifacts and bounded explicit
   synchronization delegate unchanged to Slice 3 and HC-2 V3. An interrupted
   connection never reconnects automatically. Already journaled exact V3
   bytes remain available to the file fallback without replanning.
7. **Collaborators and devices** — render accepted read-only people, role,
   membership, device, pending-invitation, recovery, and history-boundary
   evidence. Owner actions revalidate in the injected authority port; displayed
   state never grants authority.
8. **Conflicts** — show every observed contender and bind the complete displayed
   set to an explicit authorized decision. Reviewer resolution is disabled;
   arrival order and “keep latest” are never offered.
9. **Recovery and blocked states** — reconstruct next guidance from durable
   evidence after reopen. Closing the workspace stops only operational UI work
   and never rolls back an accepted object.

The workspace is a presentation over an explicitly injected qualification
driver. Every command includes the project identity and current durable
evidence revision. The driver must revalidate control head, epoch, membership,
device, conflict contender set, and compare-and-swap journals before invoking
existing authority. React state has `authority: "none"`; corrupt or stale
component state therefore cannot manufacture an authoritative operation.

## Handoff, files, and failure behavior

Clipboard, OS sharing, file save/selection, QR, camera, and peer construction
are explicitly invoked ports. A cancelled or denied port retains the same
prepared artifact for retry. Opaque files are bounded before reading; extension
and MIME are hints only; canonical bytes, intended device, authentication, and
duplicate handling remain authoritative. Download object URLs are revoked in
the same action. Closing or switching projects invalidates pending UI results,
cancels QR tracks, invokes operational cleanup, clears rendered QR and pasted
text, and unmounts the workspace.

The integrated UI does not add a watcher, polling loop, WebSocket, HTTP sync
endpoint, service worker, automatic retry, background sync, discovery, public
STUN/TURN, relay, rendezvous, or signaling service. Direct peers retain the
Slice 3 `{ iceServers: [] }` boundary.

## QR rendering and scanning

`qr@0.6.0` is pinned and lazy. The provider first runs the existing strict
HC-3 handoff or authenticated-direct parser and the frozen 2,953-character
single-symbol limit. It then produces a structured boolean matrix with fixed
byte encoding, low error correction (the setting needed by the frozen maximum
capacity), mask 0, and a four-module quiet border. React paints cells through
the Canvas 2D structured API. No arbitrary SVG or HTML string is inserted;
the interface uses no `innerHTML`, `dangerouslySetInnerHTML`, `eval`, dynamic
function construction, remote image, font, or QR service. The full artifact is
hidden by default and an adjacent Copy fallback remains available. QR carries
no additional authentication, confidentiality, or authority.

Scanning preference is native `BarcodeDetector` with `qr_code` support,
followed by explicit image selection through the same reviewed package's
decoder, followed by paste. Camera permission is requested only by **Scan QR**.
The scanner reports the selected capability, retains no frames, performs no
upload, parses decoded text through the strict HC-3 parser, and stops every
media track on success, cancellation, error, close, visibility loss, or
unmount. Scanning only fills the preview field; the same preview and explicit
confirmation remain required.

## Capability fallbacks

No browser-name or user-agent check is used. Probes run only after explicit
qualification entry.

| Capability | Fallback or blocked behavior |
| --- | --- |
| Clipboard write | Select and copy exact text manually |
| Web Share text | Copy exact text |
| Web Share files | Save the encrypted file |
| Save-file picker | Browser download |
| Open-file picker | File upload control |
| Download/upload | Operation blocked if DOM file controls are unavailable |
| QR render | Included reviewed lazy provider |
| Native QR scan | Image selection, then paste |
| Image QR scan | Paste exact text |
| Camera | Image selection, then paste |
| WebRTC data channel | Send encrypted update |
| IndexedDB | Device collaboration is blocked |
| Non-extractable key persistence | Setup is blocked |
| Web Locks | Existing transactional coordination fallback |
| OPFS | Selected portable folder |
| File System Access | Download and upload controls |
| Required WebCrypto | Device collaboration is blocked |

The non-extractable-key probe writes an ephemeral non-extractable AES key to a
dedicated temporary IndexedDB database, reads it back, closes the database, and
deletes it. The WebRTC probe creates and immediately closes a data channel with
an empty ICE-server list. WebCrypto probes only local SHA-256 and AES-GCM.

## Accessibility and responsive behavior

The workspace is an `aria-modal` named dialog. Initial focus moves to its
heading, Tab is trapped inside, Escape closes only while idle, and focus is
restored to the invoking menu path. Status changes use a polite atomic live
region; failures use `role=alert`; consequences are adjacent to confirmation
actions; state is conveyed in text, not color. Technical identities and
capabilities are in a separate disclosure. Controls are keyboard-operable and
keep a logical heading hierarchy. Long artifact and diagnostic text wraps.

Qualification covers desktop and 390×844 layouts, the repository's 200%-zoom
equivalent viewport, reduced motion, and forced-colors borders. The narrow
layout becomes a full-height workspace with horizontally scrollable step
navigation and no page-level horizontal overflow.

## Browser evidence and limitations

The primary integrated test exercises Chrome 151.0.7922.174 in two isolated
profiles through the actual File menu and workspace. Its production adapter
validates typed `hc2_hc3` evidence from the assembled authority runtime; it
does not inject presentation snapshots. The 39 product assertions drive real
HC-1 foundation/projector/checkpoint work, HC-2 recovery custody, invitation,
non-extractable enrollment and possession, encrypted V2 admission, receipt,
bounded V3 replication, and epoch rotation, plus HC-3 signed offer/answer and
real WebRTC. Two independently accepted title mutations reconstruct the same
conflict on both devices, the reviewer is rejected, the owner resolution is
carried through the explicit encrypted-file closure, and both profiles reopen
with equal authoritative objects, projection, authority, acknowledgements,
receipts, state blob, and snapshot. The admitted device remains
`full_history_verified: false`.

The same test also proves source-byte immutability, real reload with no hidden
work, project-switch rebinding without accepted-state leakage, close cleanup,
desktop layout, and 390×844 layout. Deterministic drivers remain only in
focused presentation and failure-state tests. The Slice 3 regression remains
the deeper transport proof: 1,188 assertions cover interruption/fresh attempt,
535 exact V3 transfers, final zero-object sync, and portable reopen equality.
Evidence for this exact Chrome build does not imply Safari, Firefox, Edge,
older Chromium, mobile, or different network support.

Production enablement remains out of scope. A production slice must approve and
package the now-qualified authority assembly behind a separate production
go/no-go decision, complete hostile-platform and multi-engine qualification,
settle application-wide CSP/Trusted Types policy, address portable
plaintext-at-rest policy, and design revocation messaging for already delivered
ciphertext.

## Slice 5 recommendation

Slice 5 can now begin, bounded to production-readiness evidence: qualify the
existing real authority assembly across supported engines/devices and hostile
permission states, adopt a strict application CSP/Trusted Types policy where
compatible, complete supply-chain and privacy review, and produce a signed
production-enablement decision. Do not add cloud signaling, automatic
synchronization, relay infrastructure, or new protocol authority as part of
that work.

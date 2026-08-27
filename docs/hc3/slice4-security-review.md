# HC-3 Slice 4 security and dependency review

## Decision

Slice 4 is accepted for explicitly injected development qualification only.
It is not accepted for production enablement. The existing production gate is
the primary security boundary; UI state, QR, camera, clipboard, files, and
WebRTC remain authority-free presentation or transport ports.

## QR dependency provenance

The repository had no QR encoder. The first reviewed package name,
`@paulmillr/qr@0.3.0`, was rejected when the npm registry marked it deprecated
in favor of the same maintainer's current `qr` package. It was removed before
implementation. The selected direct dependency is exactly `qr@0.6.0`:

- source: `https://github.com/paulmillr/qr`, created 2023-03-02, active and not
  archived at review time, with recent repository activity on 2026-08-14;
- npm release: 2026-04-28; prior maintained line includes 0.4.0 through 0.5.5;
- license: MIT or Apache-2.0;
- registry integrity:
  `sha512-P23VoX7SipHALdiIYG+D+LT/6n22dNKwV92FAb3d+Nlki/5WisSsfLt0UDFz2XEBtuwrECTznvu+chKKFCSYhA==`;
- tarball: 129,506 bytes compressed, 520,808 bytes unpacked, 19 files; main
  encoder source is 71,111 bytes and decoder source is 58,119 bytes before
  application bundling;
- transitive runtime dependencies: none;
- native binaries and lifecycle install scripts: none; installation was run
  with lifecycle scripts disabled;
- published package is ESM, declares `sideEffects: false`, and keeps encoding,
  decoding, and DOM helpers in separate exports;
- package documentation reports approximately 9 KiB gzipped for encoding and
  18 KiB for encoder plus decoder; the production build/chunk inspection is the
  authoritative Patchmark measurement.

The npm advisory query reported no vulnerability attributable to `qr@0.6.0`.
The repository-wide audit still reports seven existing findings (one moderate,
six high) through Next/Sharp/PostCSS, MDXEditor/js-yaml, nanoid, and lint tooling.
Those findings predate and are independent of the zero-dependency QR package;
they remain release blockers to triage separately and were not auto-fixed in
this slice because that would change unrelated application dependencies.

Source/tarball scans found no `eval`, `new Function`, remote fetch, WebSocket,
EventSource, unsafe HTML insertion, lifecycle script, native binding, or
runtime network path. The integration imports `qr` only in the gated lazy
qualification chunk.

## Threat review

- **Production gate:** production ignores the injected development signal and
  returns the frozen synchronous disabled sentinel before dynamic import or
  capability work. URL, fragment, storage, cookie, extension, artifact, and
  public environment attempts do not participate in the decision.
- **UI versus authority:** snapshots and artifacts carry `authority: "none"`.
  Commands bind project identity and durable revision. The product adapter
  accepts only exact `hc3_product_authority_evidence` records with
  `authority: "hc2_hc3"`, an allowed action boundary, durable revalidation,
  canonical accepted-object identities, and an exact-byte SHA-256 for V3 or
  direct transport. The primary two-profile product test assembles this adapter
  over the real HC-1/HC-2/HC-3 browser runtimes; deterministic snapshot drivers
  are limited to focused presentation and failure-state tests. Stale UI results
  are discarded after close or project switch.
- **QR exposure:** QR can reveal the same metadata as the exact manual text to
  observers, cameras, screenshots, and messenger history. It adds no security.
  The rendered matrix is cleared on artifact change and close.
- **Camera:** permission follows an explicit click. Tracks stop on every
  terminal path and visibility loss. No frame, decoded image, or artifact is
  uploaded or persisted by the UI.
- **Clipboard and messenger:** copied/shared Invitation, Response, receipt, or
  connection metadata may remain in OS history or third-party services. The UI
  keeps this privacy guidance separate from technical diagnostics.
- **Files:** extension and MIME are hints. Exact bytes and cryptographic checks
  remain authoritative. Bounds precede full reads; cancellation retains the
  prepared bytes; object URLs are revoked.
- **WebRTC metadata:** manually exchanged descriptions can expose device,
  session, epoch, fingerprints, host candidates, timing, and size metadata to
  the recipient and local network. Empty ICE servers avoid external discovery
  but make connectivity intentionally limited.
- **Direct/file equivalence:** both carry exact journaled encrypted V3 bytes and
  converge through the same importer, projector, roots, checkpoints,
  acknowledgements, and receipts. The UI never treats channel delivery as
  acceptance.
- **Revocation:** current authority is checked before peer construction and
  cryptography. Rotation excludes revoked devices from replacement delivery.
  Revocation cannot erase ciphertext or manual artifacts already delivered.
- **Plaintext at rest:** the portable collaboration folder retains the existing
  HC-2 documented plaintext-at-rest limitation. Slice 4 does not claim device
  disk encryption or add a cloud database.
- **Denial of service:** text, image dimensions, file bytes, direct frames, and
  rounds are bounded. Malformed items fail closed before authority.

## CSP and Trusted Types readiness

The workspace requires no inline script, eval, dynamic function, arbitrary HTML
or SVG insertion, remote QR asset, remote font, automatic navigation, or raw
artifact interpolation. QR uses Canvas 2D. Artifacts remain out of URL query and
path construction, so they do not enter server logs through this integration.
Errors and status messages redact secret-bearing diagnostics; code does not log
raw artifacts, keys, recovery material, or decrypted data.

Patchmark does not yet enforce a broad application CSP or Trusted Types policy.
This slice deliberately avoids a global policy change because unrelated editor
dependencies need separate compatibility qualification. Application-wide CSP,
Trusted Types enforcement, and reporting-endpoint privacy remain production
blockers.

## Compatibility and residual blockers

Capability decisions are feature probes rather than browser-name checks. The
only exercised integrated browser is Chrome 151.0.7922.174. Native camera QR
scanning is reported only when `BarcodeDetector` advertises `qr_code` and camera
access exists; otherwise the qualified image/paste fallback is shown. No Safari,
Firefox, Edge, mobile, or Chromium-floor claim is made.

Before production, Patchmark still needs production approval and packaging for
the qualified authority assembly, multi-engine and mobile device qualification,
permissions/recovery usability testing, full dependency-advisory remediation
decisions, application-wide CSP and Trusted Types, portable plaintext policy,
revocation communication design, and a final independent security review.
Cloud signaling, relay, TURN, public STUN, accounts, automatic sync, and
background retry remain explicitly absent.

# HC-3 Slice 5 production-readiness evidence

Status: development qualification only
Classification: `conditional`
Production collaboration: unconditionally disabled
Baseline: `a7c4153daebb794a2eca84151035b3c04c1f9c79`

## Decision

The HC-1/HC-2/HC-3 assembly is technically coherent in the exercised Chrome
environment, and enablement design may continue. Production enablement is not
approved. Production-optimized CSP and Trusted Types qualification now passes
for the normal disabled application and the test-only real-authority harness.
Enablement remains blocked on Safari/Firefox/Edge and physical-device evidence,
real camera/share/filesystem qualification, non-Chrome custody persistence,
residual dependency findings, plaintext-at-rest/privacy approval, and
independent security/privacy review.

The machine-readable decision is `readiness-slice5.json`. Missing evidence is
never a pass. `conditional` means the design may proceed only while the
production gate remains closed; it is not permission to ship.

## Real assembly audit

The interface path remains File menu → the existing collaboration-shadow
production resolver → a development-only lazy loader → the actual workspace →
the injected product authority adapter → the existing HC-1 store/projector,
HC-2 custody/enrollment/admission/V2/V3/rotation, and HC-3 manual direct
transport. There is one product driver. The deterministic presentation driver
is used only by focused tests. The primary two-profile product suite injects
the assembled real authority runtime, not snapshots.

Every product action carries project identity and expected evidence revision.
Authority evidence requires `authority: "hc2_hc3"`, accepted object IDs, a
durable revalidation flag, and exact V3 digest where applicable. Authority-
changing cuts revalidate accepted control state. UI snapshots, capability
results, file hints, QR, clipboard, share, and camera all have
`authority: "none"`. Close, reload, and project switch discard presentation
work and reconstruct from durable evidence. V3 direct and file paths retain
the exact journaled bytes.

Production and import-graph tests keep the workspace as the sole gated HC-3
product import. The production resolver ignores URL, fragment, environment,
storage, cookie, injected value, and artifact attempts and returns a frozen
disabled sentinel before dynamic import or capability work. No test authority
runtime is imported by a production module.

## Capability contract

The former available/fallback/blocked presentation matrix is now a strict
typed state contract: `supported`, `unsupported`, `permission_required`,
`permission_denied`, `temporarily_unavailable`, `lost_during_operation`,
`incompatible_result`, and `not_exercised`. Every row carries a trigger,
fallback, blocking flag, and stable diagnostic code. The matrix remains
authority-free and records that no permission-bearing operation was invoked.

Entry-safe functional probes cover required WebCrypto, empty-ICE-server data
channel construction, QR format support, `canShare` file compatibility,
IndexedDB strict transaction plus non-extractable key reopen, Web Lock
acquisition, and OPFS root access. Clipboard, camera, and native picker
permissions are requested only by their corresponding user actions. Probes
close peers, channels and databases, release locks, and delete the temporary
database. User-agent strings are never inspected.

Operation failures distinguish denial before use, loss during use, temporary
unavailability, and incompatible results. They never retry automatically and
record whether resources were released and the exact prepared artifact remains
available. A browser that cannot reopen non-extractable custody is blocked;
extractable-key fallback is forbidden.

## Hostile permissions, files, camera, and lifecycle

Deterministic browser-boundary tests cover clipboard denial, share cancellation,
share/file incompatibility, native save failure after exact bytes were written,
writable abort, download interruption, object-URL revocation, partial/appended/
truncated reads, MIME/extension hints, post-selection source substitution,
camera denial, track end, visibility loss, malformed QR, repeated scan, and
unmount cancellation. Presentation failures caused zero authority mutations.

The scanner now listens for track termination, stops every track, detaches
visibility/track listeners, cancels animation frames, and clears video stream
references on every terminal path. Image bitmaps close in `finally`, including
dimension and decode failure. Authority actions use a synchronous in-flight
guard in addition to evidence revision checks, so double clicks cannot create
parallel authority requests. Project switching unmounts the workspace and
invokes operational cleanup.

Existing Slice 2 and Slice 3 suites remain the deeper browser-port and hostile
peer evidence: cancellation/permission outcomes keep exact artifacts, file
bounds precede parsing, peers close on constructor/offer/answer/ICE/channel
failure, text and conflicting frames fail closed, floods and backpressure are
bounded, exact duplicates are idempotent, simultaneous offers choose no
automatic winner, and revocation revalidates before peer construction and at
V3 cuts. No watcher, reconnect, polling, or retry was added.

## Storage pressure and durability

HC-2 storage tests cover IndexedDB absence/open/transaction failure, strict
transaction behavior, quota-based read-only classification, partial portable
writes, invisible staging fragments, atomic markers, OPFS failure/eviction,
Web Lock contention, concurrent tabs, non-extractable key reopen, missing
custody, and reconstruction. Optional caches and presentation guidance never
create authority. Missing custody blocks rather than replacing identity.

The integrated product test presents success only after the real authority
runtime returns durable evidence. It reopens after accepted setup, recovery,
admission, replication, conflict decision, and revocation; both profiles
reconstruct equal accepted bytes, events, controls, authority, epoch,
projection, conflict cores, roots, checkpoint, state blob, snapshot,
acknowledgements, and receipts. Abrupt close after a durable transition may
lose the success presentation, never the accepted object.

## CSP and Trusted Types

The original strict-policy command remains useful negative evidence:
`PATCHMARK_HC3_SLICE5_POLICY=strict node
scripts/collaboration-hc3-slice4-browser.test.mjs` starts `next dev`. Next 15's
development Webpack wrapper invokes `eval` before hydration. The corresponding
development client does not exist in `npm run build`; React development,
Fast Refresh, HMR, the overlay, and eval-backed source maps are also absent.
Trusted Types never failed independently in that run because CSP stopped the
development runtime first. The earlier blocked production conclusion was
therefore too broad. `unsafe-eval` was not added; the result is retained as a
development-harness limitation.

The real application was rebuilt with `npm run build`, served with `next
start`, and exercised with collaboration still synchronously disabled. Its
enforced profile is:

```text
default-src 'self';
script-src 'self' 'nonce-…'; script-src-attr 'none';
style-src 'self' 'nonce-…'
  'sha256-441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk=';
style-src-attr 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self';
connect-src 'self';
media-src 'self' blob:; worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; frame-ancestors 'none';
form-action 'self'; manifest-src 'self';
trusted-types default nextjs#bundler; require-trusted-types-for 'script'
```

`strict-dynamic` is deliberately absent from this normal profile. Next
production makes a duplicate unnonced request for its same-origin Webpack
runtime after hydration; with `strict-dynamic`, CSP reports that request even
though the parser copy is nonced. The compatible profile therefore admits
only same-origin script plus nonced bootstrap. The optimized collaboration
harness below does use `strict-dynamic`. No remote script source is admitted.

The normal profile creates exactly two policies. The qualification-owned
`default` policy implements only `createHTML`; it accepts one exact, frozen
169-byte Radix Select viewport CSS string and rejects every other value. The
matching style hash authorizes only those bytes. It returns no arbitrary HTML,
script text, or script URL. `nextjs#bundler` is Next/Webpack's private runtime
policy for build-computed chunk URLs. The qualification bootstrap replaces its
generated identity rule with a validator that accepts only same-origin HTTPS
or loopback `/_next/static/chunks/*.js` paths and rejects credentials, query,
fragment, other paths, and other origins. Its object is not exposed to
application or fixture input, and hostile HTML, script URL, worker URL, and
inline-script probes all fail with `TypeError`.
The style-attribute exception is limited to existing React style properties
and cannot execute script.

The normal profile passed hydration, project open, Visual and Markdown modes,
save state, two-document navigation, reading bookmarks, File and Review menus,
comments, the 48 px bar, project switching, reload, and every production
activation vector. It created no collaboration DOM, authority runtime,
WebRTC, camera, worker, custody, or replica activity. All 230 deployable build
artifacts, the initial graph, routes, and manifests contained no optimized
harness or test-authority marker.

The test-only collaboration harness is built in production mode with the
repository's bundled Webpack, SWC, and Terser. It has production React,
minification, no HMR/Fast Refresh/overlay, no source maps, and a fixed
same-origin public path. Its entry and output are under `scripts/` and
`.hc3-slice5-optimized/`; neither enters a production source edge or deployable
build artifact. The enforced harness profile is:

```text
default-src 'self';
script-src 'nonce-…' 'strict-dynamic'; script-src-attr 'none';
style-src 'self'; style-src-attr 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
media-src 'self' blob:; worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; frame-ancestors 'none';
form-action 'self'; manifest-src 'self';
trusted-types patchmark#optimized-bundler;
require-trusted-types-for 'script'
```

The sole `patchmark#optimized-bundler` policy is Webpack's private
production-runtime policy. The test-only optimizer replaces Webpack's identity
rule with an exact same-origin HTTPS-or-loopback
`/assets/optimized-harness-<content-hash>.js` validator; credentials, query,
fragment, other names, paths, and origins are rejected. The policy is not
exposed to artifact or UI input. The full two-profile workflow passed 52 browser
assertions with simultaneous CSP and Trusted Types enforcement: foundation,
recovery, invitation and QR, strict parse/preview, enrollment and possession,
V2 admission and receipt, concurrent mutations, empty-ICE-server WebRTC,
real V3, encrypted-file fallback, equal conflict reconstruction, reviewer
rejection, owner resolution, revocation and rotation, pre-cryptography cutoff,
portable reopen equality, final zero-object V3 synchronization, and cleanup.

Hostile tags, event handlers, SVG, `javascript:`/`data:` strings, bidi text,
long labels, malformed and QR-decoded artifacts, filenames, paths, and
secret-like encodings remained text or were rejected. No supported seam
produced trusted HTML or an executable URL. QR remains structured Canvas work;
`iceServers: []` needs no remote connection source. Both completed profiles
recorded zero unexpected policy or runtime events and no full artifact or
secret in diagnostics.

## Engines, devices, and accessibility

Chrome 151.0.7922.174 on arm64 macOS 26.2 is exercised headless in two isolated
profiles. IndexedDB, strict transactions, non-extractable key reopen,
WebCrypto, Web Locks, WebRTC, direct V3, file fallback, reload, and reopen pass.
Headless Chrome does not provide real OS sharing, camera, or physical QR
evidence, so those rows remain conditional or not exercised.

Safari 26.2 is installed, but Safari WebDriver refused a session because
remote automation is disabled. That setting was not changed. Firefox and Edge
are absent. The paired iPhone 15 was unavailable; no relevant physical device
was exercised. See `external-qualification-slice5.md` for reproducible Safari,
Firefox, Edge, iOS, Android, and desktop pass rules.

The integrated Chrome suite covers keyboard operation, named modal/controls,
focus entry/restore, polite and alert live regions, permission-error focus,
390×844 layout, long wrapping, reduced motion, forced-colors borders, and
technical disclosure. The Slice 5 privacy section uses ordinary language and
keeps protocol detail collapsed. Manual VoiceOver/NVDA/TalkBack and physical
200% zoom/touch review remain required.

## Privacy, diagnostics, and abuse

The workspace now explains separate-copy creation, non-confidential handoff
and QR artifacts, clipboard/messenger/file-provider retention, encrypted-file
size/timing leakage, WebRTC network metadata and limited internet reachability,
file fallback, revocation limits, partial history at admission, recovery
separation, custody loss, and plaintext local folders. It never calls WebRTC
anonymous or transport encryption at-rest encryption. The dedicated at-rest
decision record makes the exposure and future design choices explicit.

Runtime code contains no HC-3 console logging. Diagnostic redaction removes
artifact prefixes, long key/signature-like encodings, recovery/private-key
terms, clipboard contents, bidi controls, and local absolute paths. User labels
are NFC-normalized, stripped of controls and bounded; React renders them as
text. Policy events record directives and origins only.

Existing HC-1/HC-2/HC-3 tests cover oversized and wrong-kind carriers,
cross-project/session substitution, replays, revoked peers, stale owner state,
delayed/reordered/duplicated/truncated/flooded frames, conflicting duplicates,
simultaneous offers and authority mutations, project switching, MIME/name
disagreement, and corrupt presentation. Slice 5 adds safe-looking malformed QR,
bidi labels, repeated completion, and permission/lifecycle cuts. Rejections
preserve accepted state and pending exact V3 bytes and never render attacker
HTML.

## Dependency and release posture

The compatible audit repair reduced vulnerable package records from seven to
four without lifecycle scripts or collaboration dependency changes. Residual
MDXEditor/js-yaml and Next/PostCSS records require major migrations or an
upstream backport and remain documented release blockers. `qr@0.6.0` remains
pinned, zero-dependency, signed-release traceable, locally source-scanned, and
free of an npm advisory, but byte-for-byte reproducible publish evidence and
single-maintainer continuity remain conditional. See
`dependency-review-slice5.md`.

## Exact prerequisites and Slice 6 scope

Before production-enablement implementation:

1. complete the external engine and physical-device protocol;
2. prove non-extractable custody and recovery on every supported floor;
3. exercise camera, QR, share, file and real intended network paths;
4. resolve or formally accept the four residual audit records;
5. approve privacy and plaintext-at-rest language;
6. complete manual accessibility and independent security/privacy review;
7. approve browser floors, support/incident response, rollback, and format
   commitments; and
8. obtain explicit authorization to alter the production gate.

Recommended HC-3 Slice 6 is evidence closure only: external engine/device
qualification, editor/framework dependency migrations, privacy/accessibility
approvals, and independent go/no-go. No Chrome security-policy blocker remains
from Slice 5, but every supported engine must repeat the applicable profile. It
must not add cloud signaling, STUN/TURN, relay, automatic sync/retry, a new
driver, a new authority model, or production enablement itself.

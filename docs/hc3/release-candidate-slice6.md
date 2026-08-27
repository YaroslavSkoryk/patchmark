# HC-3 Slice 6 release-candidate evidence closure

Status: development qualification only
Classification: `conditional`
Production collaboration: unconditionally disabled
Baseline: `96aea97e939b8f7e5e21a1fcb3d30131a9e008eb`

## Decision

Slice 6 does not authorize a release or production-enablement implementation.
The exercised Chrome architecture remains coherent and the evidence package is
auditable, but external browser engines, real OS permissions, physical devices,
screen readers, privacy/product approval and independent security review are
missing. The full and production-only npm audits also retain product-reachable
MDXEditor/js-yaml and build-time Next/PostCSS records. Missing evidence is not a
pass and no risk acceptance is invented.

The machine matrix contains 32 requirements: 12 `pass`, 4 `conditional`, 3
`blocked` and 13 `not_exercised`. `conditional` means architecture and evidence
work may continue only while the frozen production gate remains closed. It is
not permission to design or ship an enablement change.

## Slice 5 baseline closure

The clean committed baseline is Slice 5 commit `96aea97e`. The accepted path is
still File menu → frozen production resolver → development-only lazy workspace
→ actual integrated workspace → one real product authority driver → existing
HC-1/HC-2/HC-3 stores, projectors, custody, enrollment, admission, V2/V3,
manual transport and portable reopen. Deterministic drivers remain limited to
focused presentation/failure tests and cannot be selected by URL, fragment,
environment, cookie, storage or user input.

The primary two-profile optimized suite reconstructs real accepted objects,
semantic/control sets, frontiers, authority, epoch, projection, revision heads,
conflicts, tombstones, rejections, five roots, composite root, checkpoint,
state blob, snapshot, acknowledgements and receipts. It includes concurrent
mutations, exact encrypted-file fallback, empty-ICE WebRTC, conflict decisions,
revocation/rotation and durable reopen/project isolation.

## Dependencies and QR

Fresh full and production-only audits each report four vulnerable package
records: two moderate and two high. `@mdxeditor/editor@3.55.0` brings
`js-yaml@4.1.1`; untrusted Markdown frontmatter can reach its quadratic parser.
`next@15.5.24` pins `postcss@8.4.31`; Patchmark supplies only trusted repository
CSS, so its advisory surface is build-time, but the records remain. Available
fixes require MDXEditor 4.2.2/Lexical-family requalification or Next 16.3.3 and
framework/build-policy requalification. No migration, override, forced audit
repair or suppression was applied.

`qr@0.6.0` is retained as `accept_pinned_dependency`. Published integrity,
signed source tag/commit, 19-file unpacked contents, licenses, zero dependency
graph, no install/native/network/eval surface, narrow encoder/decoder imports,
deterministic matrices and maximum-boundary behavior were reviewed. A rebuild
from the source commit produced byte-identical unpacked files. Independent
review and a monitoring owner remain conditions.

## Platforms and external evidence

Chrome 151.0.7922.174 on macOS 26.2 is exercised headless with two isolated
profiles and real persisted non-extractable keys. It is classified
`supported_with_fallbacks` for this synthetic desktop workflow, not as an
approved production floor. Safari 26.2 is installed but automation remains
unavailable without a user settings change; Firefox and Edge are absent. A
paired iPhone 15 is detected but did not run the browser workflow. No Android
device exists. Safari, mobile, cross-engine, real LAN/NAT and physical evidence
remain `not_exercised`.

The test-only external runner uses the same optimized application and real
authority driver. It serves only a user-controlled local listener, displays an
evidence-session ID, uses synthetic projects, records browser capabilities and
size/hash commitments, separates manual from automated assertions, exports no
secrets and has `authority: "none"`. Its parser and source-hash invalidation are
test infrastructure and never production or protocol input.

## Privacy, accessibility and independent review

The privacy package supplies ordinary-language disclosure and three explicit
choices: accept plaintext local storage, require encrypted-at-rest projects, or
ship only an explicitly labeled technical preview. It explains local disk,
backup/sync/shared-account/lost-device exposure, public invitation/connection
artifacts, encrypted-file size/timing, peer network metadata, no relay, file
fallback, revocation limits, partial-history admission and recovery. No choice
is approved.

Automated Chrome evidence covers keyboard/focus/live regions, denial fallback,
headings/names, non-color state, narrow/long layout, forced colors, reduced
motion, targets, QR alternative, camera/file fallback, technical disclosure,
error recovery and project switching. Manual protocols define exact VoiceOver,
TalkBack and NVDA actions, speech, focus, failures, capture and cleanup. No
screen-reader review occurred.

The independent package defines trust boundaries, authority/custody/recovery,
V3/WebRTC/file/revocation/conflict behavior, production lock, CSP/Trusted Types,
storage exposure, dependencies, fixtures, limits, threat model, known risks,
commands, high-value questions and a go/no-go template. It contains no secrets
or user paths. No independent reviewer has used it.

## Support, rollback and evidence invalidation

The support design covers browser floors and degradation, recovery/lost device,
revocation, corruption, redacted diagnostics, compatibility, fixture retention,
incident/privacy response, direct-connectivity limits and the fact that no
Patchmark server can retrieve local projects. Rollback removes future UI entry
in a signed local release while preserving accepted portable authority. It
adds no kill switch or server dependency.

`review-manifest-slice6.json` hashes reviewed source/evidence bytes. Tests mark
evidence stale if any covered file, dependency/lockfile, frozen fixture,
browser floor, CSP/Trusted Types policy, product authority driver or protocol
version changes. A stale conclusion cannot remain current.

## Remaining decision items

Blocked: MDXEditor/js-yaml, Next/PostCSS, and privacy/plaintext approval.

Conditional: exercised Chrome platform scope, pinned QR dependency, support and
rollback ownership/drill, and loopback-only WebRTC.

Not exercised: Safari, Firefox, Edge, physical iOS, physical Android, real OS
permissions, macOS VoiceOver, iOS VoiceOver, Android TalkBack, Windows NVDA,
independent security/privacy review, real LAN/NAT/firewall connectivity and the
complete physical-device workflow.

## Next slice recommendation

HC-3 Slice 7 should be an evidence-import and external-review closure slice,
not production enablement: execute the package on named supported platforms,
attach strictly validated authority-free records, complete screen-reader and
privacy/security reviews, resolve or formally accept dependency blockers,
approve a browser floor and run an authority-preserving rollback drill. A
separate, explicitly authorized design may consider production enablement only
after those decisions are current.

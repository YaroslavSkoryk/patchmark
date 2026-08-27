# HC-3 Slice 6 independent security-review package

Status: `not_exercised`
Production collaboration: disabled
Reviewer independence: required; implementation self-review is not independent

## Review target and trust boundaries

Patchmark is local-first. A portable project directory and the browser profile
are user-controlled storage; another admitted device and every carried artifact
are untrusted inputs. The operating system, browser WebCrypto/IndexedDB, local
filesystem and explicit human confirmations form the platform boundary.
Patchmark has no account, cloud project database, signaling, discovery, public
STUN, TURN, relay, presence, telemetry or server authority.

HC-1 defines immutable Markdown/object identities, semantic and control events,
accepted order, projection, conflicts, five component roots, composite root,
checkpoints, state blobs and snapshots. HC-2 defines owner/reviewer authority,
device signing and HPKE custody, mandatory recovery, invitation/enrollment,
possession, V2 admission/receipt, membership, revocation, epoch rotation,
encrypted V3 journals, explicit synchronization and acknowledgements/receipts.
HC-3 provides strict authority-free text/link/QR/file carriers and manually
signaled WebRTC framing. Transport never creates authority; imported bytes pass
HC-2/HC-1 validation and transactional acceptance.

Device signing and HPKE keys remain non-extractable browser `CryptoKey`
objects. Losing custody requires recovery or re-admission; compatibility cannot
export a key. Recovery material is user-carried separately. A newly admitted
device verifies current state and keeps `full_history_verified: false` unless a
separate historical proof exists.

WebRTC uses signed manual offer/answer descriptions, `iceServers: []`, bounded
framing/backpressure and exact V3 bytes. It has no authority and no automatic
retry/reconnect. Encrypted-file V3 is the fallback. Revocation rejects future
work before peer construction/cryptography/persistence but cannot recall data
already delivered. Concurrent semantic changes remain concurrent; the
projector creates deterministic conflict cores and only authorized control
evidence resolves them.

## Production and browser security boundary

The frozen production resolver returns disabled before storage, crypto,
randomness, timers, workers, permissions or network work. URL, query, fragment,
environment, storage, cookie, console, extension and pasted input cannot open
collaboration. Production contains no route, protocol handler, file association,
dynamic entry, initial/lazy collaboration chunk or qualification runner.

The normal production application and test-only optimized real-authority build
enforce CSP and Trusted Types without `unsafe-eval` or broad trusted sinks.
Structured Canvas QR rendering, React text rendering, bounded diagnostics and
same-origin chunk URL policies constrain executable sinks. Review both policy
generation and deployable build scans; do not infer the test harness is a
production route.

Portable projects may contain plaintext Markdown and authority metadata.
Transport encryption does not encrypt the directory. Backups, synced folders,
shared accounts, malware and lost unlocked devices are honest exposures.
Invitations/connection descriptions are non-confidential; encrypted files leak
size/timing; direct peers observe network information.

## Dependency and limits review

Review `dependency-disposition-slice6.md` and `qr-disposition-slice6.md`.
MDXEditor/js-yaml is product-reachable from untrusted Markdown frontmatter and
remains a release blocker. Next/PostCSS is build-only with trusted CSS but still
an unresolved audit record. QR is pinned with reproducible unpacked contents,
zero runtime dependencies and narrow encoder/decoder imports; single-maintainer
continuity remains.

Review canonical encoders, domain strings, object limits, carrier text limits,
bundle/framing limits, dependency closure, transaction byte budgets, journal
recovery, flood/backpressure handling and pre-allocation rejection. Frozen
fixture hashes and covered source hashes are in
`review-manifest-slice6.json`. Any mismatch invalidates conclusions.

## Threat model and high-value questions

Threats include malicious project content, forged/replayed/cross-project
artifacts, stale owner state, revoked devices, reordered/duplicated/truncated
frames, simultaneous offers/actions, local storage corruption/rollback,
compromised dependencies, browser custody loss, XSS/Trusted Types bypass,
diagnostic leakage, hostile permissions/lifecycle, local attacker access to
plaintext, metadata disclosure and social engineering around non-confidential
QR/invitations.

The reviewer should answer:

1. Can any presentation, index, cache, transport or imported evidence create
   accepted authority or bypass dependency closure?
2. Are project/session/epoch/device/domain bindings complete across V1/V2/V3,
   direct descriptions, frames, journals, receipts and checkpoints?
3. Can revocation race peer creation, decryption, acceptance or persistence?
4. Can arrival/replay order choose an arbitrary semantic winner or hide a
   conflict/reducer rejection?
5. Are non-extractable keys ever exported, replaced or silently regenerated?
6. Can corrupt storage expose partially committed authority or unindexed
   accepted objects after reopen?
7. Can hostile Markdown/frontmatter, labels, carriers, filenames or policy
   reports reach HTML/script/URL/CSS sinks or leak secrets?
8. Are QR and dependency dispositions supported by source, package-manager and
   bundle evidence?
9. Does disabled production stop before all side effects and exclude every
   test runner/module/marker from deployable output?
10. Are plaintext, network metadata, revocation, partial-history and recovery
    claims accurate and prominent enough for the chosen release scope?

## Reproduction commands

From a clean reviewed checkout with the recorded Node/npm and installed Chrome:

```text
npm ci --ignore-scripts
npm run test:collaboration-hc3-slice6
npm run test:collaboration-hc3-slice6-types
npm run test:collaboration-hc3-slice6-external-browser
npm run test:collaboration-hc3-slice5-production-policy-browser
npm run test:collaboration-hc3-slice5-optimized-browser
npm run test:collaboration-hc3-slice4-production-browser
npm run test:collaboration-hc3-slice4-browser
npm run typecheck
npm run lint -- --no-cache
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Then run every current non-browser `test:*` script, every relevant collaboration
browser suite, representative single-user browser suites and the external
physical/browser protocols. Confirm fixture and review-manifest hashes before
interpreting a result. Tests may generate only synthetic profiles/projects and
must clean them.

## Expected deliverables and go/no-go template

The independent reviewer delivers identity/qualification, scope and manifest
hash, methods, reproduced tests, findings with severity/exploitability,
dependency/QR disposition, privacy review, residual risks, remediation/retest
criteria and one recommendation: go to enablement design, conditional with
named approvals, or no-go.

```text
Reviewed commit:
Manifest SHA-256:
Reviewer and organization:
Independence/conflicts:
Platforms actually exercised:
Findings and dispositions:
Dependency/QR decision:
Privacy/plaintext decision:
Residual risks:
Required fixes/approvals:
Recommendation: GO / CONDITIONAL / NO-GO
Date and evidence expiration:
```

The package contains no live secrets, private keys, recovery material, personal
project content or absolute user paths. No independent reviewer has completed
it; status remains `not_exercised`.

# RB-1 human-collaboration freeze and product release boundary

Status: frozen before public release
Frozen implementation commit: `f1b30158ec511786f64149e7166b3ad5b90e3232`
Frozen implementation scope: HC-1, HC-2, and HC-3 through Slice 7A
Human-collaboration release state: `false`
Agent-exchange release state: `false`
Production enablement: `false`

## Checked-in release authority

`lib/release/product-release-state.ts` is the single production release
authority for human collaboration and agent exchange. Its frozen object contains
two independent compile-time literals:

```ts
{
  human_collaboration: false,
  agent_exchange: false
}
```

The definition imports no feature implementation and reads no environment,
URL, fragment, cookie, browser storage, IndexedDB, project metadata, Markdown
frontmatter, protocol artifact, user preference, clock, browser global, remote
configuration, database, network, crypto, filesystem, or secret. Resolution is
synchronous and returns frozen state. A future release requires changing the
reviewed literal, rebuilding production, rerunning feature-specific
qualification, and making a separate go/no-go decision.

The existing collaboration-shadow entrypoint remains the only human-
collaboration product load boundary. In production it consults the checked-in
authority and returns the existing disabled sentinel before its dynamic import.
The optimized Webpack assembly consumes that same source object in
`next.config.ts` and excludes the human-collaboration loader while its literal
is false; this build integration is not a second flag or release authority.
The established injected `development_shadow` seam remains available only in
development and tests; a production runtime ignores it. Agent exchange has only
the shared typed release resolution. RB-1 adds no agent-exchange component,
route, handler, protocol, action, loader, placeholder interface, or dynamic
import.

## Frozen human-collaboration implementation

The frozen baseline contains the implemented local-first collaboration core,
portable replica and custody system, invitations and enrollment, encrypted
manual exchange, bounded synchronization, direct manually signaled WebRTC,
production-locked product workflow, CSP and Trusted Types hardening, release-
candidate evidence, the dependency migrations, accessibility correction, and
the Slice 7A production-performance acceptance. Existing production-lock,
import-safety, route, manifest, initial-chunk, lazy-resource, frozen-fixture,
two-profile authority, encrypted-manual, and direct-synchronization evidence
remains runnable while the product surface is frozen.

Implementation in the repository does not mean deployable reachability. With
the release literal false, the public interface contains no menu item, hidden
or focusable collaboration DOM, route, handler, URL processor, protocol
registration, capability probe, storage open, receipt construction, crypto,
randomness, timer, worker, QR, camera, WebRTC, or network activity. The lazy
qualification code is reached only after the accepted gate in a non-production
qualification build. Existing normal Review Batch and ChatGPT response export/
import remains a separate single-user workflow and is not agent exchange.

Human collaboration is paused because Slice 7B external qualification and the
separate release decision are incomplete. It must not be described as released,
supported, or generally internet-reachable. The remaining Slice 7B scope is:

- Safari, Firefox, Edge, iOS Safari, and Android Chrome;
- real physical desktop and mobile devices;
- physical QR presentation and camera scanning;
- clipboard, file picker, OS Share, and permission lifecycle behavior;
- LAN, NAT, and firewall behavior for direct connections;
- VoiceOver, TalkBack, and NVDA qualification;
- independent security and privacy review;
- the plaintext-at-rest privacy decision;
- support ownership and operational drills;
- approved browser and operating-system support floors; and
- explicit final production approval.

The human-collaboration literal must not change before all applicable Slice 7B
evidence is accepted and the named product, security, privacy, accessibility,
support, and operations owners make the separate production go/no-go decision.

## Security boundary and residual facts

A client-visible runtime boolean alone is insufficient: an ordinary user can
change JavaScript variables, browser storage, cookies, or URLs. RB-1 therefore
uses reviewed source as the controlling release input and makes every public
production load path consult that source-owned state before feature code can be
loaded. Browser and imported-data activation channels are excluded rather than
treated as lower-priority overrides. Development qualification differs because
it is an explicit non-production test seam and never changes the checked-in
release decision.

Human collaboration and agent exchange have separate keys and independent
resolution. Enabling one prospective test literal leaves the other disabled.
Agent-exchange qualification currently returns only typed state and has no
implementation load edge. Future AE work must retain that separation and may
not weaken the collaboration production lock or its regression suites.

This release gate is not authorization inside an enabled feature. After a
future release, HC-1/HC-2/HC-3 identity, membership, device, cryptographic,
admission, replay, and authority validation remain responsible for human-
collaboration security, and AE must define its own authority before release.
Changing and rebuilding the source is a developer release action, not an
ordinary user activating the hosted public application. Source changes must
review the applicable implementation graph, routes and handlers, CSP and
Trusted Types posture, storage and capability surface, protocols and formats,
dependency and fixture impact, support plan, rollback behavior, and all feature-
specific qualification evidence.

## Release posture

RB-1 freezes availability, not maintenance. Collaboration source, protocols,
fixtures, tests, evidence, manual exchange, and direct synchronization
qualification remain in the repository and runnable. Production remains
disabled. The repository may branch for AE-1 only after RB-1 validation passes;
that branch does not authorize human-collaboration release or begin Slice 7B.

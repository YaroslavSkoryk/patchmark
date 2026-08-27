# Future HC-3 production-enablement go/no-go checklist

This checklist is preparation only. Completing it does not itself authorize a
gate change. Production remains unconditionally disabled until a separately
approved implementation explicitly alters that boundary.

- [ ] Every `conditional`, `blocked`, and `not_exercised` Slice 6 readiness
  entry has reviewed evidence and an owner-approved disposition.
- [ ] The supported browser, engine, OS, device, and minimum-version floor is
  explicit; all claimed targets completed the external qualification protocol.
- [ ] Physical iOS, Android, and supported desktop evidence covers custody,
  camera, QR, share, files, lifecycle, and real intended network paths.
- [ ] Product and privacy owners approve invitation, metadata, WebRTC,
  revocation, recovery, clipboard, messenger, file-provider, and plaintext-
  at-rest language.
- [ ] The plaintext-at-rest decision is explicitly accepted or replaced by a
  separately designed, migrated, recovered, and qualified encrypted format.
- [ ] The product-reachable MDXEditor/js-yaml path and build-time Next/PostCSS
  path are migrated or receive formal security/product risk acceptance; no
  audit record is suppressed.
- [x] QR provenance, published integrity, source commit, unpacked reproducibility,
  narrow imports and deterministic vectors are rechecked; independent approval
  and a monitoring owner remain open.
- [x] Chrome production and the test-only optimized real-authority bundle pass
  strict CSP and Trusted Types without `unsafe-eval` or a broad default policy;
  external engines remain covered by the separate platform requirement above.
- [ ] The current threat model and every Slice 6 abuse case receives
  independent review.
- [ ] Recovery is rehearsed from loss of local custody on every supported
  platform; no path silently creates a replacement identity.
- [ ] Product owners accept that revocation cannot recall already delivered
  data or artifacts.
- [ ] Production rollback is designed without deleting or silently migrating
  accepted authority, portable projects, or device custody.
- [ ] V1, V2, V3, HC-3 carrier, authority, fixture, and data-format compatibility
  commitments are explicit for the supported lifetime.
- [ ] User support covers failed admission, missing custody, stale state,
  conflicts, interrupted WebRTC, file fallback, device loss, and recovery.
- [ ] Incident response defines dependency, key-custody, malicious-peer,
  artifact-disclosure, and rollback procedures without telemetry assumptions.
- [ ] Independent security and privacy reviewers issue a recorded go/no-go.
- [ ] A named approver explicitly authorizes changing the production gate.
- [ ] The Slice 6 review manifest is current; no covered source, dependency,
  fixture, browser floor, policy, authority driver or protocol version changed.
- [ ] The enablement change proves no URL, fragment, environment, storage,
  cookie, extension, console, script, route, or pasted input can bypass the
  approved product entry and authority checks.

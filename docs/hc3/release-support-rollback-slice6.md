# HC-3 Slice 6 release support, incident response and rollback design

This design does not enable production collaboration and introduces no remote
kill switch, server authority or account dependency.

## Support contract before enablement

- Publish an approved browser/OS/device floor and unsupported-browser message.
  Capability checks explain an exercised fallback or block before authority
  work. Missing non-extractable custody or required cryptography always blocks.
- Support recovery rehearsal, lost-device re-admission, revocation limits,
  corrupt portable projects, conflicts, interrupted direct connections and
  encrypted-file fallback. No Patchmark server can retrieve keys, repair local
  directories, discover peers or resend artifacts.
- Diagnostic export contains versions, typed codes, sizes, commitments,
  fixture/manifests hashes and cleanup only—never document text, complete
  carriers, private/recovery material, absolute paths or camera frames.
- Commit to retaining V1/V2/V3 and HC-3 frozen fixtures and documenting read,
  write and migration support periods. Never silently migrate accepted
  authority or overwrite the source project.
- Direct connectivity support must say that empty ICE servers provide no relay
  or public traversal. Failure across NAT/firewall is expected; exact encrypted
  file exchange is the supported fallback.

## Rollback and emergency disablement

UI enablement, if separately authorized later, must remain a local, reviewed
build decision. Rollback ships a new application build that closes the entry
point before storage, crypto, permissions or network work. It does not delete,
rewrite, downgrade or invalidate accepted collaboration projects, authority,
custody, recovery material or encrypted files. Users retain read/export and
version-compatible recovery instructions.

Emergency disablement is the same signed release/build rollback; there is no
hidden remote switch, account lookup, server policy or telemetry command. If a
format reader is unsafe, the release may block opening affected collaboration
projects with a local versioned diagnostic while preserving bytes for a later
repair tool. Never “repair” by dropping unknown accepted objects.

## Incident playbooks

Dependency advisory: inventory exact paths/reachability, freeze affected
enablement, apply the smallest compatible family update, run full regressions,
invalidate evidence and publish scope/workaround. Do not suppress audit output.

Custody or malicious-peer issue: stop new admission/sync in the next build,
preserve portable bytes, give local recovery/revocation guidance, explain that
delivered data cannot be recalled, and require new independent review.

Privacy issue: stop enablement, preserve projects, update approved disclosure,
support safe local export/deletion and notify users through ordinary release
channels. No content collection is introduced.

Corruption: make a copy, run read-only inventory/checkpoint/root verification,
export redacted evidence, and restore only through versioned authority-aware
tools. Support cannot reconstruct unavailable local content or keys.

## Owners and approvals

Before enablement, name owners for browser floors, recovery support, dependency
monitoring, security incident response, privacy response, accessibility,
format compatibility and user communication. Approve rollback behavior in a
release drill that demonstrates the UI closes while a previously accepted
portable project remains byte-identical and reopenable by the compatible
qualification build.

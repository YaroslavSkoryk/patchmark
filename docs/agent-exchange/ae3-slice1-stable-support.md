# AE-3 Slice 1 — stable Codex support boundary

Status: stable-provider release evidence complete; production release remains
disabled. The checked-in release state remains:

```ts
{
  human_collaboration: false,
  agent_exchange: false
}
```

AE-2 is technically complete. This slice qualifies a stable provider and
defines the narrow first-release boundary; it does not approve a release,
package a connector, add an installer, or resume Human Collaboration.

## Frozen stable target

At task start on 30 August 2026, the latest official non-prerelease Codex CLI
was `0.151.0`, published 29 August 2026 as
[`rust-v0.151.0`](https://github.com/openai/codex/releases/tag/rust-v0.151.0).
The official [Codex changelog](https://learn.chatgpt.com/docs/changelog)
identifies the same release. Official release metadata marked it
`prerelease: false`. A newer `rust-v0.152.0-alpha.1` prerelease also existed
and was deliberately excluded.

Qualification used the official
`codex-package-aarch64-apple-darwin.tar.gz` in a task-owned temporary
directory. Its SHA-256 was
`cb6e78eba80c1bc310a533f6f1c6c948377733bc06f9e837949334e04abde9c6`,
matching both the official release metadata and checksum manifest. The
extracted `bin/codex` identified itself as `codex-cli 0.151.0` and had
SHA-256
`98491713ffb196061003ee148636e743997cc31d76144ba7c53462269896891d`.
It reused the normal provider-owned ChatGPT authentication mechanism without
login, logout, credential copying, auth-file inspection, or config mutation.

## Compatibility result

The existing AE-2 invocation and event parser worked unchanged. Codex 0.151.0
retains noninteractive `codex exec`, stdin prompt input, `--ephemeral`,
`--ignore-user-config`, `--ignore-rules`, `--strict-config`, read-only
sandbox selection, configuration overrides, and JSONL output. Official
0.151.0 config metadata and a no-model fixed-profile probe confirmed every
Patchmark disable key remains recognized.

The stable live lifecycle was:

```text
thread.started
turn.started
item.completed (agent_message)
turn.completed
clean process exit
```

That is semantically identical to the AE-2 alpha lifecycle. The connector
relies on no usage field. Additive usage fields and other unknown optional
fields were ignored, while unknown event types, tool-bearing items, ambiguous
ordering, missing completion, malformed JSONL, and non-zero exits still fail
closed. No adapter parser, process, protocol, schema, or fixed-invocation change
was required.

Relevant changes since the previous alpha family included MCP startup and
extension work, plugin catalog configuration, sandbox/permission fixes,
remote-sandbox context improvements, stdin-review telemetry, authentication
and remote-MCP fixes, and Unix shutdown fixes. Patchmark remains insulated:
user config and rules are ignored; web, shell, file, MCP, app, plugin, browser,
computer-use, image, hook, memory, and multi-agent surfaces are explicitly
disabled; and no approval bypass is present.

## Exact support policy

The checked-in policy has three explicit classifications:

- Publicly supported: exactly `0.151.0`.
- Development/legacy qualification evidence: exactly
  `0.148.0-alpha.15`.
- All other strings and versions: unsupported.

The default connector accepts only the public exact allowlist. The legacy alpha
remains documented evidence but cannot authorize a public connector exchange.
Nearby `0.150.1`, `0.152.0-alpha.1`, future `0.152.0`/major versions, and
malformed versions are rejected with the existing bounded unsupported-version
UX and exact manual-export fallback. There is no version range and no
future-version inference.

For the first release, exact local allowlisting is the runtime authority.
Version-specific release tests and an isolated no-model capability probe
supplement it; flag presence alone never authorizes an unqualified version.
AE-3 Slice 2 should package the reviewed allowlist and may add a package
integrity/capability preflight without making that preflight a version-range
escape hatch.

Codex updates should be handled by reviewed connector releases that update a
checked-in compatibility manifest/policy only after mechanical and live
qualification. A hosted page may report compatibility information, but remote
mutable metadata must not change trusted versions, security policy, Agent
Exchange release state, or Human Collaboration state.

## Stable live qualification

One real model turn exercised the actual development Patchmark UI:

```text
Send to agent
→ Prepared Exchange
→ authenticated loopback connector
→ isolated Codex 0.151.0
→ AE-1 binding
→ strict protocol-v2 importer
→ existing reply and patch review UI
```

The invented fixture contained no user document or private project. Its
canonical request was 31,657 bytes with SHA-256
`07146d92d3f14d6e422b847252a5ee6763f07be0d7149e16fdc5b5b0968032b3`.
Manual export, Prepared Exchange, loopback-decoded bytes, and Codex stdin were
byte-identical. The request traveled only through stdin to a direct no-shell
child in a fresh empty connector-owned temporary cwd; no Patchmark
project/repository path, browser-selected flag, arbitrary environment, or
arbitrary filesystem path was supplied.

The stable response produced one reply and two independent proposals. The
existing strict importer accepted them atomically. Authoritative Markdown was
unchanged after import. A human explicitly accepted one proposal and rejected
the other in the existing UI; only accepted text entered Markdown. Reply and
decision state, including the rejection, persisted after reload and project
reopen.

The first machine event arrived after 1.638 seconds, Codex exited cleanly after
15.783 seconds, and Patchmark reached response-ready after 16.518 seconds. The
typed usage event reported 13,823 input tokens, 0 cached input tokens, 0 cache
write input tokens, 516 output tokens, and 24 reasoning-output tokens. Normal
model variance from the AE-2 alpha run is not a regression.

No tool, approval, shell, file, MCP, app, browser, computer-use, image, or hook
event occurred. An inert shell-like literal created no file. Patchmark did not
inspect, copy, proxy, print, or store credentials. Codex output remained
untrusted and gained no patch acceptance or comment-resolution authority.

## Initial release-support assessment

Qualified now:

- macOS 26.2 on Apple silicon;
- Chrome 152.0.7977.64;
- exact Codex CLI 0.151.0;
- user-launched loopback connector;
- real Patchmark UI, real connector, real stable Codex, strict import,
  Accept/Reject, and reopen;
- existing deterministic 390 px responsive coverage and production graph
  isolation.

Mechanically supported but not physically qualified:

- other current Chromium desktop builds;
- Intel macOS;
- Windows and Linux Node/process implementations, including their deterministic
  process-tree paths.

Unsupported for the initial public matrix:

- Safari and Firefox;
- Windows and Linux physical end-to-end use;
- mobile and tablet connector use;
- all Codex versions other than exact `0.151.0`, including prereleases;
- managed/autostart/background connectors.

The recommended first public matrix is therefore macOS on Apple silicon,
Chrome 152, exact Codex 0.151.0, and a user-launched local connector. Chrome-only
is not misleading for this first boundary because the actual File System
Access/project workflow and loopback private-network behavior have only been
qualified there.

AE-3 Slice 2 should package one target first: a macOS Apple-silicon,
user-launched Patchmark Connector with the checked-in exact Codex compatibility
policy and explicit upgrade/unsupported recovery. Windows, Linux, Intel macOS,
browser expansion, auto-start, and managed lifecycle remain later
qualification work.

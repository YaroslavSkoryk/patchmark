# AE-2 Slice 2 — local Codex connector

Status: development qualification only. `human_collaboration` and
`agent_exchange` remain `false`; the production build still removes the Agent
Exchange qualification loader. This slice does not authorize a release.

## Start the connector

The connector is a user-launched Node process, not a Next.js route and not a
browser worker. From this checkout, allow the exact Patchmark origin that will
use it:

```sh
npm run agent-exchange:connector -- --allow-origin https://patchmark.example
```

For local development only, HTTP is accepted only with the explicit loopback
override:

```sh
npm run agent-exchange:connector -- \
  --allow-origin http://127.0.0.1:3000 \
  --allow-insecure-loopback-origin
```

The fixed browser endpoint is `http://127.0.0.1:43187`. A port conflict fails
visibly; the connector does not scan the machine for another port. macOS uses
the Codex binary bundled with ChatGPT by default. A user may locally select a
different installed binary with `--codex-executable /absolute/path/to/codex`.
That setting exists only in the connector process and is never accepted from a
browser request.

Startup prints a high-entropy, one-time pairing code to the local terminal. In
Patchmark, choose **Send to agent**, enter that code, then choose **Pair and
send**. A successful redemption rotates the terminal code and issues an
origin-bound session capability. The capability is held only in JavaScript
memory: it is not stored in a project, URL, cookie, `localStorage`,
`sessionStorage`, or IndexedDB. Reloading the tab therefore requires pairing
again. Stopping/restarting the connector invalidates all prior sessions.

## Provider behavior

Each accepted exchange creates a new empty temporary directory and one direct,
no-shell `codex exec` child. Patchmark writes the already-prepared AE-1 request
to stdin exactly once and closes stdin. It does not put document content in
argv, a path, an environment variable, a URL, or a shell command.

The qualified profile uses ephemeral execution, ignores user config and rules,
skips Git discovery, requests a read-only sandbox, disables web search and all
qualified tool/extension features, and consumes JSONL. It selects the last
completed `agent_message` only if a known `turn.completed` follows and the
process exits cleanly. Tool-bearing, malformed, ambiguous, oversized, failed,
or non-zero streams fail closed. The exact qualified Codex version for this
slice is `0.148.0-alpha.15`; every other version is reported unsupported.

The connector does not read, parse, copy, store, display, or proxy provider
credentials. Codex owns its existing local authentication. The child receives
only a small OS/path/temp/config environment allowlist; provider API-key
environment variables are not forwarded. An authentication failure becomes a
typed operational failure and the exact manual-export fallback remains
available.

The selected surface follows the official
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode):
`codex exec` accepts stdin, supports ephemeral execution, and emits JSONL turn
and item events. Patchmark adds the stricter version-pinned, zero-tool and
loopback controls described here.

## Local HTTP boundary

- Binds only the IPv4 loopback literal `127.0.0.1`.
- Requires exact configured `Origin` and exact `Host` on every route, including
  preflight; there is no wildcard CORS and no cookie authentication.
- Uses a 256-bit one-time pairing code and a separate 256-bit bearer session,
  compared with constant-time secret checks and bound to connector instance +
  Patchmark origin.
- Exposes only status, pair, exchange, owned cancellation, and revocation.
- Rejects unknown JSON fields, non-canonical base64, digest/length mismatches,
  unexpected verbs/routes/content types, oversized bodies, unowned cancels,
  and origin/token replay.
- Sends only operation ID, protocol/version, byte length, SHA-256, response
  ceiling, and canonical bytes. Project/document/review identities remain in
  the AE-1 browser binding and are not local-server command inputs.
- Allows one active provider operation globally and does not queue. A second
  operation receives `busy`.
- Cancels on AE-1 abort, authenticated DELETE, browser connection loss, revoke,
  or connector shutdown. POSIX uses a process group with a bounded SIGTERM →
  SIGKILL fallback; Windows uses owned process-tree termination. Temporary
  directories and late responses are discarded on every terminal path.

Provider request bytes are capped at 1 MiB. Provider response bytes are capped
at the smaller of the AE-1 operation ceiling and 8 MiB. JSONL stdout and stderr
have separate absolute bounds. These are provider-operational limits only and
do not change the existing manual export/import contract.

## Failure and recovery UX

Unreachable connector, unpaired/revoked session, unsupported Codex, missing
Codex, authentication failure, provider failure, busy state, invalid protocol,
oversize output, crash, and cancellation all return bounded typed failures.
Patchmark never auto-retries a provider turn. The UI preserves the exact
prepared request so **Use manual export instead** remains available. A response
still passes through the existing protocol-v2 byte importer, stale ownership
checks, atomic persistence, and human review; the connector gains no patch
acceptance or comment-resolution authority.

## Qualification

No test invokes a live model. The executable fixture supports exact-byte
capture, delayed success, auth/provider/non-zero failures, malformed and
unknown events, missing/multiple/ambiguous final messages, forbidden tool
items, oversized streams, hangs, cancellation races, and version mismatch.

```sh
npm run test:agent-exchange-ae2-slice2
npm run test:agent-exchange-ae2-slice2-types
npm run test:agent-exchange-ae2-slice2-browser
```

The browser qualification runs the actual editor UI and real loopback HTTP
boundary against the fake executable. It covers wrong/correct pairing, keyboard
focus, exact AE-1 request bytes, importer persistence, cancellation, exact
manual fallback, active-request reload, late-result rejection, console/network
cleanliness, and a 390 px viewport.

## Deliberate limits

This development slice adds no installer, auto-start service, persistent jobs,
provider settings, model/provider selection, App Server, SDK/MCP dependency,
approval UI, arbitrary command endpoint, cloud relay, or production enablement.
It does not protect against a compromised OS, a privileged local process, or a
malicious browser extension with access to the paired page. Broader Codex
versions, browsers, operating systems, packaging, updates, and public-origin
policy require a later release qualification.

# AE-3 Slice 2 — connector packaging and user lifecycle

Status: the macOS Apple-silicon package and user-launched lifecycle are
mechanically qualified. The final authorized packaged Codex `0.151.0` turn
used the Slice 2D artifact, returned HTTP `200`, reached `ready`, imported one
synthetic reply and zero patches, and made no retry. Public distribution
remains blocked on a production-origin package, Developer ID signing,
notarization, stapling, clean-machine Gatekeeper verification, and an
authorized HTTPS distribution channel. The checked-in release state remains:

```ts
{
  human_collaboration: false,
  agent_exchange: false
}
```

This slice does not enable either product, start a managed service, add an
update channel, broaden Codex compatibility, or extend the release matrix.

## Frozen first target

The package target is deliberately one physical environment:

- macOS on Apple silicon;
- Chrome 152;
- exact Codex CLI `0.151.0`;
- Patchmark Connector `0.1.0` and local protocol `1`;
- user-launched, foreground operation on `127.0.0.1:43187`.

Intel macOS, Windows, Linux, Safari, Firefox, other Chromium versions, mobile,
managed deployment, login items, background services, and automatic updates
remain outside this slice. The package does not contain or redistribute Codex.

## Build the package

The package command requires the reviewed build environment: macOS arm64,
Node 22 for the repository command, and exact Bun `1.3.12` as the bundler and
embedded runtime source. These are build-time requirements only. The resulting
artifact needs none of Node, npm, Bun, TypeScript, the repository, or a source
checkout at launch.

Production-origin form:

```sh
npm run package:agent-exchange-connector -- \
  --output /absolute/path/outside/the/repository \
  --allow-origin https://patchmark.example
```

Qualification-only loopback form:

```sh
npm run package:agent-exchange-connector -- \
  --output /tmp/patchmark-connector-qualification \
  --allow-origin http://127.0.0.1:3120 \
  --qualification-loopback
```

The command rejects repository-local output, malformed origins, non-loopback
HTTP, unsupported build platforms, and unexpected arguments. It bundles and
minifies the connector into JavaScript, copies the exact embedded Bun runtime,
normalizes metadata, emits a sorted USTAR archive with timestamp-free gzip,
and prints the artifact path, target, runtime, byte size, SHA-256, and signing
state. Two builds from the same inputs are byte-identical.

The archive contains only:

```text
Patchmark Connector.command
README.txt
THIRD_PARTY_NOTICES.txt
app/connector.js
package-manifest.json
runtime/bun
```

It contains no TypeScript, source maps, `node_modules`, package-manager state,
test fixture, repository path, credentials, project data, or Codex binary. The
manifest freezes connector identity, protocol, target, supported Codex list,
runtime version, file sizes, and file SHA-256 values.

## Install, launch, pair, use, and quit

1. Install exact Codex `0.151.0` through an official standalone, Homebrew, npm,
   Codex app, or ChatGPT app route. Codex owns its existing local sign-in.
2. Extract the archive and double-click **Patchmark Connector.command**. Keep
   the Terminal window open.
3. Confirm the local status shows connector `0.1.0`, protocol `1`, supported
   Codex `0.151.0`, detected compatibility, `127.0.0.1:43187`, and the
   Control-C quit instruction. Executable paths and environment values are not
   printed or sent to the browser.
4. In Patchmark, choose **Send to agent**, enter the one-time code printed in
   Terminal, and choose **Pair and send**.
5. Review the returned replies and proposals in the existing strict import and
   Accept/Reject UI. Manual export remains available on every failure.
6. Return to Terminal and press Control-C. SIGINT and SIGTERM stop the server,
   abort the owned provider process tree, remove its temporary directory, and
   erase the in-memory pairing code and origin-bound session.

The connector creates no daemon, login item, LaunchAgent, persistent queue,
saved job, saved session, startup project scan, or update process. Launch alone
runs only the connector; Codex starts only after an authenticated exchange.
Quitting or crashing loses all pairing and request state. Relaunch generates a
new connector instance and pairing code; no response is resumed or recovered.

## Codex discovery and compatibility

The official Codex CLI documentation currently supports standalone installer,
Homebrew, and npm installation, but does not promise one universal executable
path. The official standalone installer uses `$HOME/.local/bin/codex`. The
connector therefore examines only this reviewed list, in order:

1. `$HOME/.local/bin/codex`;
2. `/opt/homebrew/bin/codex`;
3. `/usr/local/bin/codex`;
4. the Codex macOS app resource location;
5. the ChatGPT macOS app resource location.

There is no filesystem scan, shell lookup, browser-supplied path, PATH-derived
selection, or persisted override. Every existing executable is checked with a
direct, no-shell `codex --version`. Exact `0.151.0` wins deterministically even
when another installation is unsupported. Missing, inaccessible, malformed,
fake, older, nearby, prerelease, and future versions fail closed. A supported
binary that changes after launch is rechecked before every exchange and becomes
unavailable or unsupported rather than inheriting prior trust.

The loopback status handshake exposes only bounded compatibility metadata:
connector ID/version, protocol version, exact supported Codex versions,
detected Codex version/compatibility, busy state, pairing state, and random
instance ID. It never exposes executable paths, environment values,
credentials, project paths, request content, or pairing secrets. The browser
requires connector ID `patchmark.local_codex_exec`, connector `0.1.0`, protocol
`1`, and the exact supported list. A mismatch produces **Patchmark Connector
needs an update** and fails closed before pairing or provider execution.

Compatibility changes require a reviewed Patchmark Connector release and a
checked-in exact allowlist change after deterministic and live qualification.
Hosted metadata may explain compatibility but cannot authorize a version.
There is no remote allowlist, version range, automatic trust of future Codex,
or automatic connector/Codex update.

## Local lifecycle and recovery

The fixed port remains `127.0.0.1:43187`; random fallback ports are forbidden.
If an existing listener returns the exact connector identity, version,
protocol, and supported Codex list for the configured Patchmark origin, a
second launch reports **already running** and exits successfully without
printing another pairing code. An unrelated listener, incompatible connector,
wrong-origin connector, malformed response, or unresponsive listener is
reported as a collision. The second process does not kill it or select another
port. No lock file or marker exists, so abrupt termination cannot leave durable
authority or a stale lock; the OS socket is the single-instance boundary.

Patchmark presents distinct bounded recovery states:

- connector not running: launch it, then choose **Try again**;
- Codex missing/unusable: install exact `0.151.0`, relaunch, and try again;
- Codex unsupported: replace it with exact `0.151.0`;
- connector incompatible: quit and install the package for this Patchmark
  build;
- pairing lost/restarted connector: enter the new one-time code;
- busy/provider/import failure: retry only by explicit user action;
- any failure: use the exact manual export instead.

There is no polling-driven retry, background restart, automatic resend,
recovered model result, or inferred success.

## Security boundary preserved

Packaging does not change the AE-1 portable bytes, operation binding, strict
protocol-v2 importer, atomic persistence, stale ownership checks, or human
review authority. The server remains exact-Origin and exact-Host, no-wildcard
CORS, memory-capability authenticated, one-operation-only, size bounded, and
fail closed. The provider remains one direct no-shell `codex exec` child in a
fresh empty connector-owned temporary directory, with exact stdin bytes,
minimal environment, ignored user config/rules, ephemeral read-only sandbox,
and the frozen zero-tool profile. Browser requests cannot select executable,
argv, cwd, model, permissions, environment, files, tools, or network access.
Patchmark does not inspect, copy, proxy, display, or store Codex credentials.

## Exact Codex 0.151.0 event classification

The earlier packaged real-provider attempts failed at the strict JSONL parser
before import. Their sanitized evidence retained the HTTP error code but not
the rejected event type, so it cannot identify the historical event without
guessing. The correction instead used the preserved official 0.151.0 archive,
its exact binary and `codex exec --help`, plus OpenAI's
[non-interactive-mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
to prove the version-matched public vocabulary independently.
The exact binary exposes `thread.started`, `turn.started`, `turn.completed`,
`turn.failed`, `item.started`, `item.updated`, `item.completed`, and thread
error events. Its public item vocabulary includes `agent_message`, `reasoning`,
`error`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
`todo_list`, and `collab_tool_call`.

The adapter now applies this explicit table in every item lifecycle phase:

| Event category | Classification | Connector behavior |
| --- | --- | --- |
| `thread.*`, `turn.*` | lifecycle | Validate order; never use as response content. |
| completed `agent_message` | authoritative | The last completed message before `turn.completed` is the only imported response candidate. |
| started/updated `agent_message` | invalid in 0.151.0 | Reject as an impossible lifecycle phase. |
| completed `reasoning` | inert metadata | Accept and discard without storing, returning, logging, or diagnosing reasoning content. |
| started/updated/completed `todo_list` | inert plan metadata | Accept and discard; it grants no file, process, network, MCP, image, or collaboration authority. |
| top-level or item-level `error` | typed failure | Fail as authentication-required when a typed top-level code proves it; otherwise fail as provider failure. |
| `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `collab_tool_call` | forbidden authority | Terminate the Codex process tree immediately and fail closed. `image_generation` is not a 0.151.0 `ThreadItem` and is rejected as unknown. |
| any unknown top-level or item type | unsupported | Terminate immediately and fail closed. |
| any event after a terminal event | ambiguous | Reject; no late message can replace the authoritative result. |

The connector can return one optional qualification-only structural diagnostic
header on a failed local exchange. It contains only the category, safe
top-level type, item-presence/object/type booleans, sorted safe item key names,
missing/unexpected safe field names, and one invalid-field name/kind. It never
contains an item discriminator value, status value, event content, message
text, reasoning, commands, paths, URLs, queries, arguments/results, comments,
Markdown, stderr, credentials, sessions, or environment values. The ordinary
product JSON body remains the bounded error code only. Production packages
compile both qualification diagnostic headers out.

Deterministic qualification covers every lifecycle phase, inert reasoning and
plan events, top-level and item-level failures, every known forbidden item,
unknown types, ambiguous terminal ordering, malicious diagnostic values,
process-tree termination before timeout, package rebuild/exchange, and a real
Chrome interaction through the actual package with fake Codex. The browser
fake gate imported one reply and zero patches with zero real provider turns.
The one post-correction real call is recorded below; Slice 2B ran no model
call.

## Slice 2B provider-failure diagnosis

The corrected qualification artifact with SHA-256
`4f6087feb90ce0a9b1cffd4f2b7345322aff0f093b3303059f4ebd6aeedaa42a`
successfully completed packaged discovery, compatibility, pairing, and HTTP
preflight. Its one authorized Codex turn then returned HTTP `502` with the
coarse product code `provider_failed` after 5,662 ms. The retained result had
no structural diagnostic, response, reply, patch, console error, or browser
network failure.

The historical failure source cannot be recovered exactly: the old adapter
discarded child exit code, signal, stderr metadata, typed error fingerprints,
and the distinction among top-level `error`, item-level `error`, and
`turn.failed`. That is the concrete qualification observability defect fixed
in Slice 2B. The retained evidence rules out discovery/version rejection,
known protocol/classifier rejection, response-size failure, cancellation, and
the typed `authentication_required` HTTP path. It also rules out the
connector's ten-minute operation timeout and an HTTP/browser deadline: the
failure completed in 5.662 seconds and the browser received the 502 response.
It does not support labeling the historical event as provider availability,
rate/quota, authentication, local runtime, or transient network failure.

The pre-change provider-failure decision map was:

```text
codex child
├─ top-level error / turn.failed / item error → provider_failed, no detail
├─ parseable nonzero exit or signal          → provider_failed, no detail
├─ stderr overflow                           → provider_failed, no detail
├─ timeout                                   → process signal, no timeout marker
├─ adapter/spawn exception                   → provider_failed, no detail
├─ stderr-only nonzero exit                  → invalid stream before exit mapping
└─ malformed/unknown/forbidden/no-final      → connector protocol failure
```

The adapter now retains a fixed, validated qualification record containing
only failure source; lifecycle booleans; safe typed tokens; exit code/signal;
stderr presence, length, and SHA-256; error-message presence, length, and
SHA-256; matching top-level/turn fingerprints; timeout state; terminal-event
state; and final-response state. It never retains provider prose in the
qualification protocol. A qualification package may emit that record as a
base64url JSON `X-Patchmark-Qualification-Diagnostic` response header. The
ordinary JSON body remains the existing bounded `{ error: { code } }` shape,
normal packages compile with diagnostics disabled, and the header is not CORS
exposed to product JavaScript. Invalid diagnostic objects are dropped.

The public taxonomy stays deliberately small. Reliable typed
`authentication_required`/`unauthorized` evidence may still use the existing
authentication UX; all other ordinary provider, availability, rate/quota,
runtime, nonzero-exit, and signal failures remain `provider_failed`. Patchmark
does not parse unstable English prose into product codes. Qualification
evidence distinguishes `top_level_error`, `turn_failed`, `item_error`,
`process_exit`, `process_signal`, `operation_timeout`, `stderr_overflow`, and
`adapter_exception` without broadening user-facing behavior.

`item_error` above is retained as a historical qualification value for the
pre-Slice-2D artifact. The corrected adapter does not select it as a failure
source merely because an item-level diagnostic was observed.

The JSONL allowlist and classifications are unchanged. `reasoning` and
`todo_list` remain inert; authority-bearing and unknown events still terminate
immediately; completed agent messages remain the only response candidates.
Structured provider failures may now be observed through a following
`turn.failed` and process close so duplicate fingerprints and the real exit
outcome can be recorded, but any observed provider failure still makes success
impossible.

The secret-free process boundary remains the same as the successful AE-3
Slice 1 turn: the same official arm64 Codex `0.151.0` binary and hash, fixed
argv, direct no-shell spawn, fresh connector-owned temporary cwd, filtered
environment policy, stdin prompt, read-only zero-tool sandbox, JSONL mode, and
one-process lifecycle. Packaging changes only the connector's parent runtime,
fixed executable discovery, and the intentionally isolated launch values for
`HOME`, `CODEX_HOME`, `PATH`, and `TMPDIR`; discovery, exact-version preflight,
and child startup all passed, so no packaging-specific causal mismatch is
proven. The deterministic packaged Chrome gate now captures the fake Codex
stdin and proves byte equality from Prepared Exchange through HTTP decoding to
the child, including identical byte length and SHA-256. The failed historical
turn's prompt hash remains known, but its old evidence did not retain a child
stdin commitment, so no stronger historical claim is made.

Deterministic Slice 2B vectors cover top-level error, `turn.failed`, both with
matching fingerprints, item error, structured failure plus nonzero exit,
nonzero exit without structured failure, signal exit, stderr-only failure,
operation timeout, zero exit with no final response, malformed terminal
lifecycle, failure after inert reasoning/todo metadata, and failure before an
assistant response. Raw synthetic stderr and provider messages are absent from
the HTTP body and diagnostic header. The actual packaged runtime also passes a
fake structured-failure exchange, and the packaged Chrome success gate imports
one reply and zero patches with zero real provider turns.

The next real gate should be exactly one explicitly authorized turn using the
same synthetic-only fixture, exact Chrome 152 and Codex 0.151.0, a freshly
built qualification artifact, and the new bounded header capture. It should
stop on the first terminal result, preserve only sanitized fingerprints and
lifecycle/process metadata, run no automatic retry, and require response-ready
strict import before any readiness claim.

## Slice 2C exact 0.151.0 wire reconciliation

Authoritative evidence is the annotated official tag `rust-v0.151.0` (tag
object `d8673cb68e349c208659b986697773d3145dbb14`) at commit
`78c290807ce710180111df227df3b7a4fe845452`, specifically
`codex-rs/exec/src/exec_events.rs`,
`codex-rs/exec/src/event_processor_with_jsonl_output.rs`, and
`codex-rs/exec/src/event_processor_with_jsonl_output_tests.rs`,
`codex-rs/exec/src/lib.rs`, `codex-rs/exec/src/lib_tests.rs`, and
`codex-rs/app-server/src/in_process.rs`, plus
`codex-rs/exec/tests/event_processor_with_json_output.rs`. The official
[non-interactive-mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
is supporting evidence. A disposable serializer generator was attempted from
the exact tag, but the host has no Rust toolchain; the frozen test vectors were
therefore reproduced only after a field-by-field source and official-test
cross-check. No Codex source or runtime dependency was added.

The 0.151.0 top-level event is internally tagged by `type`. Each `item.*`
contains `item: { id, type, ...variant fields }`: the `ThreadItem` variant is
flattened into the nested item object, not nested below `details`, and no
top-level or universal item `status` exists. The exact relevant wire model is:

| Codex 0.151.0 wire type | Required serialized fields | Parser | Semantic policy | Frozen fixture |
| --- | --- | --- | --- | --- |
| `thread.started` | `thread_id: string` | accepted | lifecycle | `thread_started` |
| `turn.started` | none | accepted | lifecycle | `turn_started` |
| `item.completed / agent_message` | `item.id`, `item.type`, `item.text` strings | accepted | final response | `agent_message_completed` |
| `item.completed / reasoning` | `item.id`, `item.type`, `item.text` strings | accepted | discard | `reasoning_completed` |
| `item.started|updated|completed / todo_list` | `item.id`, `item.type`, `items[{text,completed}]` | accepted | discard | `todo_list_*` |
| `item.completed / error` | `item.id`, `item.type`, `item.message` strings | accepted, including after `thread.started` and before `turn.started` | non-fatal diagnostic unless the exact 0.151.0 dropped-event integrity form | `pre_turn_error_completed`, `runtime_warning_completed` |
| `command_execution` | flattened command/output/exit/status fields | discriminator accepted | forbidden immediately | `command_execution_*` |
| `file_change` | flattened changes/status fields | discriminator accepted | forbidden immediately | `file_change_completed` |
| `mcp_tool_call` | flattened server/tool/arguments/result/error/status fields | discriminator accepted | forbidden immediately | `mcp_tool_call_*` |
| `collab_tool_call` | flattened tool/thread/prompt/state/status fields | discriminator accepted | forbidden immediately | `collab_tool_call_*` |
| `web_search` | flattened query/action fields | discriminator accepted | forbidden immediately | `web_search_*` |
| `turn.completed` | `usage` with five integer token counters | accepted | terminal success | `turn_completed` |
| `turn.failed` | `error.message` | accepted | provider failure | `turn_failed` |
| `error` | `message` | accepted | provider failure | `top_level_error` |
| unknown event/item | unknown | rejected | fail closed | negative vectors |

The concrete incompatibility was lifecycle order, not an inferred missing
field: the former parser rejected every `item.*` before `turn.started` before
it decoded the nested item. Codex 0.151.0 legitimately maps configuration
warnings, warnings, deprecation notices, and model-reroute notices to a
completed error item that may be emitted after `thread.started` but before
`turn.started`. Thus an exact valid `item.completed/error` deterministically
reproduces the former `invalid_event_stream`; Slice 2C corrected the structural
parser but still classified the item as `provider_failed`. Slice 2D supersedes
that fatality rule because the same exact tag defines `ThreadItemDetails::Error`
as a non-fatal item and keeps warning processing in `CodexStatus::Running`.

The correction is deliberately narrow: only completed error items may occupy
that pre-turn position. Other pre-turn items, impossible lifecycle phases,
missing/wrong fields, nested `details`, unknown variants, and unknown top-level
events still fail closed. Forbidden discriminators still terminate at the
earliest observed phase, before field validation. Assistant text remains the
only response candidate; reasoning and todo text are discarded; success still
requires terminal completion. Additional fields do not defeat required-field
and semantic checks, avoiding an artificial exact-key-set dependency.

Frozen vectors live in
`scripts/fixtures/agent-exchange/codex-0.151.0-wire-fixtures.json`; fake Codex
assembles its success and metadata streams from them. Integrity, old/new
regression, exact lifecycle, malformed/type/nesting, privacy, qualification
header, production-body, provider diagnostics, packaged runtime, and packaged
Chrome tests run without a model turn. Slice 2C does not broaden the exact
`0.151.0` allowlist, change portable protocols or project schemas, enable a
release flag, or alter Human Collaboration.

The corrected qualification archive is preserved at
`/tmp/patchmark-ae3-connector-packaging-W8esis/artifact-slice2c/patchmark-connector-0.1.0-macos-arm64-qualification.tar.gz`;
it is 22,238,087 bytes with SHA-256
`3e75458ba9275d134fa88f267a29b070b68fe7ef2a196667f4b3c4d88e7c3d52`.
The real-Chrome deterministic gate ran on installed Chrome `152.0.7977.65`,
completed the packaged exchange, imported one synthetic reply and zero patch
proposals, and made zero model turns. The archive contains only the six
reviewed runtime/manifest/documentation files; frozen wire fixtures and fake
Codex are not bundled.

## Slice 2D item-error fatality correction

The latest packaged real-provider gate used exactly one authorized synthetic
turn and no retry. Its sanitized record proves that Patchmark observed an
item-level `error`, an authoritative final assistant response,
`turn.completed`, and exit `0`, with no `turn.failed`, top-level `error`,
unknown event/item, forbidden authority event, signal, or timeout. The retained
privacy record does not identify whether the item was pre-turn or in-turn and
does not retain the item prose, so Slice 2D does not claim a more precise
ordering or recover that text.

Exact `rust-v0.151.0` source resolves the fatality question:

- `exec_events::ThreadEvent::Error` is the top-level unrecoverable stream
  error, while `TurnFailed` is the failed terminal turn event.
- `exec_events::ThreadItemDetails::Error` is explicitly the non-fatal error
  surfaced as an item.
- `EventProcessorWithJsonOutput::collect_warning` serializes a warning as
  `item.completed/error` and returns `CodexStatus::Running`.
- configuration warnings, runtime warnings, deprecation notices, and model
  reroutes use that same item shape without terminating the turn.
- a completed app-server turn emits `turn.completed` and initiates clean
  shutdown; a failed turn clears the final response and emits `turn.failed`.

The corrected 0.151.0 policy is:

| Event | Structural result | Semantic result |
| --- | --- | --- |
| `thread.started` / `turn.started` | accepted | lifecycle |
| `item.completed / agent_message` | accepted | authoritative response candidate |
| `item.* / reasoning` or `todo_list` | accepted in exact phases | discard |
| `item.completed / error` | accepted | bounded diagnostic only |
| authority-bearing item | typed but forbidden | immediate security failure |
| top-level `error` | accepted | fatal |
| `turn.failed` | accepted | fatal |
| `turn.completed` | accepted | successful terminal lifecycle |
| unknown/malformed event or item | rejected | fail closed |

Success now requires a valid authoritative final response selected by the
existing extraction rules, observed `turn.completed`, successful child exit,
and the absence of top-level error,
`turn.failed`, forbidden authority, unknown/unclassified structure, and fatal
stream-integrity loss. An ordinary item diagnostic cannot become response text
and cannot independently fail that complete terminal contract. Qualification
metadata remains bounded to structural booleans/tokens, item-warning count and
phase, message length/hash, and process/lifecycle state; raw provider warning
text is not returned to the product or browser.

Codex 0.151.0 has one stream-integrity caveat. Its in-process transport exposes
`InProcessServerEvent::Lagged { skipped }` structurally, but `codex exec --json`
converts that marker through `lagged_event_warning_message` into the exact
item-error prose `in-process app-server event stream lagged; dropped N events`.
The public JSONL item has no typed subtype. Patchmark therefore isolates only
that exact version-specific, anchored decimal form as fatal
`stream_integrity`; it does not use broad warning/error substring matching.
Ambiguous or unknown shapes continue to fail closed.

Deterministic regression proves the former policy rejects, and the corrected
policy accepts, item error + final response + `turn.completed` + exit `0`.
Additional vectors pass for pre-turn and multiple warnings; warning plus
`turn.failed`, nonzero exit, no final response, unknown event, forbidden tool,
top-level error, and the exact dropped-event marker all retain their required
failure behavior. The Chrome packaged-fake matrix returned HTTP `200`, reached
`ready`, imported one reply, and imported zero patches for the warning-success
path. Warning + `turn.failed`, warning + forbidden tool, and the exact
stream-integrity warning returned bounded failures, reached `failed`, and
imported nothing.

The Slice 2D qualification archive is preserved at
`/tmp/patchmark-ae3-slice2d-qualification.2NLzSu/artifact/patchmark-connector-0.1.0-macos-arm64-qualification.tar.gz`.
It is `22,238,315` bytes with SHA-256
`80c36352bd55583c00cfa304ed8604a3d2d3d24221bef7cd89f4cd2ac65c9156`.
No live model turn occurred while implementing Slice 2D. A subsequent,
separately authorized final gate used this exact archive and passed one real
Codex turn with no retry. Portable request/response protocols,
project schemas, pairing/security architecture, exact Codex allowlist,
dependencies, lockfiles, and Human Collaboration are unchanged; production
remains `{ human_collaboration: false, agent_exchange: false }`. This corrected
package is mechanical and provider qualification evidence, but it is not a
signed public-distribution artifact.

## Signing, notarization, and distribution blocker

The build host has Xcode `notarytool` 1.1.2 and the system `codesign` tool, but
`security find-identity -v -p codesigning` reports zero valid identities. No
Developer ID Application certificate, notarization credential/profile, or
release-hosting authority is available in this repository environment.
Consequently the generated package is explicitly marked `unsigned`; it is
qualification evidence only.

Public distribution is blocked until an authorized off-host release process:

1. builds the reviewed inputs on macOS arm64;
2. signs the runtime/launcher package with the Patchmark Developer ID and the
   least entitlements required by the embedded runtime;
3. verifies the hardened-runtime and designated-requirement result;
4. notarizes with Apple, staples the ticket, and re-verifies offline;
5. verifies the published SHA-256 and archive contents;
6. installs and launches on a clean Apple-silicon Mac under Gatekeeper;
7. repeats the Chrome 152 + Codex 0.151.0 packaged end-to-end qualification.

Distribution hosting, certificate custody, notarization credentials, update
delivery, and rollback remain outside this repository slice. They must not be
simulated with a fake identity or a disabled Gatekeeper check.

## Qualification commands

```sh
npm run test:agent-exchange-ae3-slice2
npm run test:agent-exchange-ae3-slice2b
npm run test:agent-exchange-ae3-slice2c
npm run test:agent-exchange-ae3-slice2d
npm run test:agent-exchange-ae3-slice2-types
npm run test:agent-exchange-ae3-slice2-packaged-fake-browser
npm run test:agent-exchange-ae3-slice1
npm run test:agent-exchange-ae2-slice2
npm run test:agent-exchange-ae2-slice2-types
npm run test:agent-exchange-ae2-slice2-browser
npm run test:agent-exchange-ae1-slice1
npm run test:agent-exchange-ae1-slice1-types
npm run test:agent-exchange-ae1-slice2
npm run test:agent-exchange-ae1-slice2-types
npm run test:agent-exchange-ae1-slice2-browser
npm run test:agent-exchange-ae1-slice2-production
npm run test:release-boundary-rb1
npm run test:release-boundary-rb1-types
npm run lint
npm run build
```

The Slice 2 suite deterministically covers discovery failures and ambiguity,
exact version changes, connector identity, reproducible packaging, manifest
hashes, absence of development files and paths, embedded-runtime launch with
Node/npm/Bun absent from PATH, pairing and exchange, graceful SIGINT/SIGTERM,
idle SIGKILL and clean relaunch, duplicate launch, unrelated port collision,
and no durable pairing or lock state. The release ceremony must additionally
preserve one packaged real Codex turn and the full browser workflow evidence.

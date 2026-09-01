# Agent Exchange initial-release readiness

Status: **NO-GO for public release**. The Agent Exchange engineering path is
qualified for the narrow matrix below, but no public artifact should be offered
until Patchmark has an exact production HTTPS origin, a Developer ID signed and
Apple-notarized package that passes downloaded-file Gatekeeper checks, and an
authorized HTTPS distribution channel. Agent Exchange and Human Collaboration
both remain disabled in the checked-in production release state.

## Initial support matrix

The proposed first release is intentionally narrow:

| Component | Qualified initial value |
| --- | --- |
| Operating system | macOS 26.2 (build 25C56) |
| CPU | Apple silicon (`arm64`) |
| Browser | Google Chrome 152.0.7977.65 |
| Connector | Patchmark Connector 0.1.0, local protocol 1 |
| Codex | Exact Codex CLI 0.151.0 |
| Patchmark boundary | Current hosted Patchmark build plus Prepared Exchange and strict Agent Exchange response protocol v2 |

This combination has physical browser, packaged-connector, deterministic
lifecycle, and real Codex provider evidence. Chrome 152 is the tested browser;
this does not imply support for every Chromium browser or every Chrome release.

Windows, Linux, Intel Macs, Safari, Firefox, Edge, mobile browsers, other Codex
versions, and other agents are not supported in the initial release because
they have not completed equivalent physical end-to-end qualification. Some
underlying code may be portable, but mechanical portability is not public
support.

## Requirements and setup

These instructions apply after Patchmark publishes the signed release package.

- Use the exact supported OS, architecture, browser, connector, and Codex
  versions above.
- Install Codex separately using the official
  [Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli) and sign in
  through Codex. Patchmark does not install Codex and does not own or store
  Codex credentials.
- Obtain the versioned Patchmark Connector archive from Patchmark's designated
  HTTPS release channel, extract it, place the connector in a user-chosen
  application location, and launch **Patchmark Connector.command**.
- Keep its Terminal window open. Confirm it reports connector 0.1.0, protocol
  1, and detected Codex 0.151.0 as supported.
- In Patchmark, choose **Send to agent**, enter the one-time code shown locally
  by the connector, then choose **Pair and send**.
- Review every returned reply and suggestion. Imported patches remain proposals
  until a person explicitly accepts them.

The connector package includes its own runtime. End users do not need Node,
npm, Bun, TypeScript, a Patchmark repository checkout, or development tools.
Codex remains a separate prerequisite.

## Everyday use and lifecycle

Launch the connector before choosing **Send to agent** and quit it with
Control-C when finished. The connector is a foreground, user-launched process;
it creates no daemon, login item, LaunchAgent, scheduled task, persistent job,
or automatic updater. It starts Codex only for an explicitly submitted
exchange.

Pairing is explicit, one-time, memory-only, and bound to the exact approved
Patchmark Origin. It does not survive connector restart. After quitting or a
crash, launch the connector again and enter its new code. An interrupted
operation is not resumed, no old result is imported, and stale session
capabilities are invalidated.

Only one exchange runs at a time. Patchmark does not silently queue another
request, poll localhost in the background, scan ports, or resend automatically.
Manual export/import remains available before and after connector failures.

## Common failures and safe recovery

- **Connector is not running:** launch it, return to Patchmark, and choose
  **Try again**. **Use manual export instead** remains available.
- **Pairing failed:** re-enter the current code shown in the connector window.
  A code is single-use; restarting the connector requires a new code.
- **Connector needs an update:** quit it, replace it with the signed connector
  version designated for the hosted Patchmark build, relaunch, and pair again.
  Patchmark fails closed on older, newer, or malformed protocol handshakes.
- **Codex is missing:** install Codex separately, then relaunch the connector.
- **Codex version is unsupported:** install exact Codex 0.151.0. The connector
  does not silently trust newer versions or use a remote compatibility list.
- **Codex authentication is required:** sign in through Codex and retry. Do not
  edit credential files manually.
- **Connector is busy:** wait for or cancel the current exchange, then retry
  explicitly. A second Codex process is not queued.
- **Provider failed or the connector quit:** nothing is partially imported.
  Retry explicitly or use the already prepared manual export.

Do not disable Gatekeeper or security software, remove quarantine attributes,
expose the loopback service externally, or use a security bypass as a supported
installation or troubleshooting step.

The connector's local output is deliberately bounded: version, supported and
detected Codex version, loopback running state, pairing code, busy state, and a
coarse failure category. It must not print request/response content, credential
material, executable or project paths, environment values, or session
capabilities. Pairing codes are necessarily displayed in the local connector
window and should be treated as short-lived secrets.

## Privacy and Codex usage

The data path is:

```text
selected canonical Patchmark review context
→ local Patchmark Connector
→ the user's local Codex CLI
→ OpenAI/Codex service under the user's Codex account and configuration
```

Only the canonical context prepared for the selected review is submitted.
Patchmark does not give the connector arbitrary Patchmark project-filesystem
authority, and the connector does not scan or attach arbitrary project files.
Patchmark does not receive or store Codex credentials; Codex owns its sign-in
and service interaction. Although the connector is local, the model operation
is not offline.

Agent output remains untrusted proposed work. Patchmark validates it with the
strict importer, binds it to the intended operation and document identities,
and requires explicit human acceptance before a patch changes Markdown.
Manual export/import remains an equivalent supported path.

Agent Exchange uses the user's existing Codex account and usage. Larger review
scopes can consume more model usage. Patchmark does not include or promise
unlimited Codex usage; current account terms and usage controls remain with
Codex. This release documentation makes no monetary price claim.

## Updates and removal

There is no automatic update. To update, quit the old connector, replace it
with the newly published signed version, launch it, and pair again. The hosted
app rejects an incompatible connector rather than downgrading its protocol.

To remove the connector, quit it and delete the extracted connector directory.
There is no additional connector-owned persistent state to remove. Removal
does not delete Patchmark projects or Codex configuration, and it leaves no
daemon, login item, scheduled task, stored credential, persistent session, or
provider child.

## Security and runtime boundary

The connector listens only on fixed loopback `127.0.0.1:43187`, accepts the
exact configured Patchmark Origin and Host, uses no wildcard CORS, requires an
origin-bound memory capability after one-time pairing, and permits one active
exchange. The browser cannot choose the executable, arguments, working
directory, environment, model, permissions, files, tools, or network access.
Codex runs directly without a shell, in an empty connector-owned temporary
directory, with the fixed read-only, zero-tool profile and bounded resources.

The hosted Patchmark build and local connector are separate runtime products.
While production release flags remain false, the optimized web graph contains
no Agent Exchange UI or connector client, no local-connector server or Codex
adapter, and no activation input can enable it. Human Collaboration is also
disabled and is outside this initial release.

## Signing, integrity, and distribution

The current qualification archive is reproducible and content-hashed, but it
is unsigned and not notarized. The packaged Bun executable does not pass strict
signature verification after bundling, no valid Developer ID signing identity
is available in the current qualification environment, and a simulated
download-quarantined copy does not pass Gatekeeper assessment. This is a
material public-distribution blocker, not a deferred enhancement.

The release process must produce a signable macOS application/container, sign
its nested runtime and outer package with an authorized Developer ID
Application identity and reviewed hardened-runtime entitlements, verify the
signature, submit it to Apple notarization, staple and validate the result, and
prove normal launch from a freshly downloaded, quarantined copy on a clean
Apple-silicon Mac. Signing credentials must be used only through an authorized
release process.

The proposed first distribution channel is a versioned GitHub Release for the
existing Patchmark repository, or an equivalent Patchmark-owned HTTPS release
channel if one is established before release. It must present clear Patchmark
identity, a versioned signed artifact, release/support notes, replacement and
withdrawal capability, and an optional published SHA-256 for advanced
verification. Platform signature and notarization are the primary user trust
path; ordinary users should not need a manual checksum step.

No public download channel, production-origin package, or release asset is
prepared by this qualification task. No fake URL should be published.

## Remaining release blockers and deferred work

Before changing `agent_exchange` to `true`:

1. select and deploy the exact production HTTPS Patchmark Origin, then build a
   production connector with qualification diagnostics disabled;
2. Developer ID sign, notarize, staple, and verify the complete package,
   including its nested runtime, and pass clean quarantined-download
   Gatekeeper launch on the qualified physical matrix;
3. establish and authorize the HTTPS release channel, publish the versioned
   signed artifact and integrity metadata, and verify obtain/install/update and
   withdrawal procedures;
4. in a separate explicit release-gate change, keep
   `human_collaboration: false`, set only `agent_exchange: true`, and repeat the
   signed-artifact and production web launch/isolation checks.

No additional live Codex turn is required before those steps: the fresh
qualification package is byte-identical to the artifact already exercised by
the final authorized real Codex gate. If signing, production-origin packaging,
or any other runtime byte changes invalidate that equivalence, one separately
authorized final live smoke is required for the changed artifact.

Deferred, non-blocking work includes Windows, Linux, Intel Mac, Safari,
Firefox, Edge, mobile, auto-start, tray UI, persistent pairing, auto-update,
multiple simultaneous exchanges, other Codex versions, other agents, and
Human Collaboration.

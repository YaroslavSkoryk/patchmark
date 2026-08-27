# HC-3 Slice 6 browser, platform and permission qualification

Date: 2026-08-27
Host: Apple-silicon MacBook Pro, macOS 26.2 (build 25C56)
Production collaboration: disabled

## Inventory

| Product | Version/path | Automation | Classification |
| --- | --- | --- | --- |
| Google Chrome | 151.0.7922.174, `/Applications/Google Chrome.app` | repository CDP harness, headless | `supported_with_fallbacks` for the exercised synthetic desktop workflow; not an approved production floor |
| Safari | 26.2 (21623.1.14.11.9), `/Applications/Safari.app` | bundled SafariDriver exits without a session; remote-automation preference is absent | `not_exercised` |
| Firefox | not installed | none | `not_exercised` |
| Microsoft Edge | not installed | none | `not_exercised` |
| Safari Technology Preview | not installed | none | `not_exercised` |
| Playwright/Puppeteer/Selenium | not installed in the repository | none | no inferred engine evidence |

Safari automation was checked without running `safaridriver --enable`, changing
Safari settings, granting permissions or altering system security. SafariDriver
26.2 is present, but no local session can be created in the current
configuration. Safari remains `not_exercised`; Chrome evidence is not Safari
evidence.

CoreDevice reports a paired iPhone 15 running iOS 26.6 and an Apple Watch.
`xctrace` reports both offline while `devicectl` reports them paired/available.
No supported browser automation, unlocked physical interaction or human
operator was available, so the iPhone was detected but not exercised. The
iPhone simulator is not physical-device evidence. No Android device is
present.

## Exercised Chrome capability result

The real two-profile Chrome suite exercises production hydration and lock,
Visual/Markdown editing, saves, document/project switching, IndexedDB strict
transactions, non-extractable signing and HPKE custody across reopen, required
WebCrypto, Web Locks, OPFS coordination, real `RTCPeerConnection` data channels
with exactly `iceServers: []`, manual offer/answer carriers, direct V3, encrypted
file fallback, conflict reconstruction/resolution, revocation, epoch rotation,
revoked-device rejection, CSP, Trusted Types and durable authority equality.
No extractable-key fallback exists.

The optimized full-authority workflow uses two isolated Chrome profiles and
passed setup, recovery, invitation/QR, V2 admission/receipt, concurrent edits,
direct V3, reversed/file exchange, conflict decisions, revocation, reload,
project switching and portable reopen. The fallback actually transports exact
encrypted V3 files; it is not a button-presence assertion. Direct WebRTC is
loopback-machine evidence only, not real LAN/NAT/firewall evidence.

Chrome headless reports capability APIs but cannot supply real macOS camera,
share sheet, native open/save panels or permission prompts. Existing tests use
explicit injected ports to prove denial, cancellation, loss and cleanup while
preserving exact artifacts; those are deterministic boundary results, not real
OS permission results. The automated result is therefore
`supported_with_fallbacks`, with production support conditional on headed and
physical-platform evidence.

## Capability and fallback rules

| Capability | Exercised result | Safe fallback/block rule |
| --- | --- | --- |
| IndexedDB and non-extractable custody | Chrome pass across profile reopen | Any engine that cannot reopen both key classes is blocked; never export keys. |
| WebCrypto suites | Chrome pass | Missing algorithms block collaboration. |
| Web Locks | Chrome pass, including contention tests | Existing transactional coordination may be used only where already qualified. |
| OPFS | Chrome pass/failure regressions | Selected portable directory remains authoritative; cache absence cannot add accepted objects. |
| File System Access | injected picker/file-provider evidence | Download/upload encrypted-file fallback must be physically exercised per target. |
| Clipboard/share | deterministic success/denial/cancellation ports | Preserve exact text/file and offer copy/save fallback; no automatic retry. |
| QR render/image decode | real deterministic Canvas and package decoder pass | Exact text/file entry remains available; camera is optional. |
| Native QR/camera | lifecycle and failure ports only | Image selection or exact text; stop every track on every terminal path. |
| WebRTC | real Chrome loopback pass with empty ICE servers | Exact encrypted V3 file exchange; no relay, STUN or automatic reconnect. |
| Trusted Types | Chrome pass | Engines without the API still must enforce CSP and safe structured sinks; never weaken the content policy. |

## Real OS permission evidence

No real macOS permission prompt was invoked. Clipboard denial, camera denial,
cancellation, track loss, visibility loss, file-provider cancellation,
permission revocation and network failure remain deterministic injected-port
evidence. Real camera, clipboard, text share, file share, open/save panel,
permission revocation, firewall and NAT outcomes are `not_exercised`.

This slice did not change macOS privacy settings, Safari developer settings,
firewall policy, NAT, browser extensions or device settings. A human operator
must execute the external protocol. Missing real permission evidence is never
upgraded from `not_exercised` because the failure ports pass.

## Platform support decision

No browser or OS production floor is approved. The proposed qualification
floor is Chrome 151 desktop, Safari 26.2 desktop, current iOS Safari on the
physical iPhone floor, and an explicitly selected Android Chrome floor; Edge
and Firefox must either complete the same protocol or be listed as unsupported.
Product, support, security and accessibility owners must approve the actual
floor after evidence exists.

# HC-3 Slice 6 accessibility evidence and manual protocols

Status: automated Chrome evidence exists; every screen-reader review is
`not_exercised`

## Mechanically covered behavior

Current Node/Chrome suites cover keyboard-only buttons and tabs, initial focus,
modal naming/descriptions, focus restoration, stale-dialog closure, polite and
alert live regions, permission-error focus, logical headings, accessible names,
non-color status borders/text, reduced motion, forced colors, 390×844 overflow,
long translated-style strings, 48 px targets, labelled QR Canvas plus exact-text
alternative, camera cancellation/lifecycle cleanup, file fallback, technical
privacy disclosure, error recovery and project switching. The production suite
also covers normal editor Visual/Markdown modes, documents, comments, menus and
reload under CSP/Trusted Types.

Automated layout evidence does not prove physical touch, browser 200% zoom,
spoken order, pronunciation, rotor navigation or mobile keyboard behavior.

## VoiceOver on macOS Safari

Starting state: fresh Safari profile, synthetic project open, collaboration
workspace closed, VoiceOver enabled by the reviewer.

Actions and expected output:

1. Open File with keyboard and choose Collaboration. Focus lands on the
   Collaboration heading; VoiceOver announces a dialog/workspace and its name.
2. Traverse headings and sections. Order is setup, recovery, invite, join,
   sync, conflicts, devices, privacy and status. No hidden control is spoken.
3. Activate setup. The recovery-required update is announced once in a polite
   region. Buttons have action-specific names, not repeated “button” labels.
4. Open and cancel each confirmation. Focus remains trapped while modal, Escape
   cancels when safe, and focus returns to the invoking control. Switch projects
   while a dialog is open; stale dialog closes and focus enters the new project.
5. Deny clipboard/camera and cancel file/share. The alert is announced once,
   focus moves to recovery guidance, and exact-text/file fallback is next.
6. Show QR. VoiceOver announces “Invitation QR code” and the adjacent exact-text
   alternative; it does not attempt to speak pixels.
7. Complete conflict/revocation. Role, contenders, consequences and current
   state are spoken without relying on color.
8. Zoom to 200%, enable increased contrast/reduced motion, repeat navigation,
   then close. No clipped control, horizontal task flow or lost focus.

Failure: missing/duplicate announcement, focus escape/loss, stale action,
unlabelled QR/camera/file control, color-only status, unreachable technical
detail, clipped content or authority action executed from a stale dialog.
Capture reviewer/version, spoken transcript deviations, focus order, settings,
screenshots without artifacts, evidence-session ID and cleanup. Current status:
`not_exercised`.

## VoiceOver on iOS Safari

Starting state: physical supported iPhone, portrait, fresh Safari profile,
synthetic owner/candidate path, VoiceOver on.

Swipe through the same logical sections; activate controls with double tap;
rotate landscape; open the keyboard; use rotor headings; invoke the share sheet,
Files picker and camera; cancel and deny each; background and return; close the
workspace. Expected speech mirrors macOS, with permission/fallback alerts once,
focus returning after native sheets, QR alternative present, 44/48 px touch
targets and no keyboard-obscured confirmation. Complete restart/reopen and
project switch. Failure and capture rules are the same, plus any focus loss
after orientation, native sheet, backgrounding or Safari restart. Current
status: `not_exercised`.

## TalkBack on Android Chrome

Starting state: physical supported Android device, fresh Chrome profile,
synthetic project, TalkBack on. Swipe and heading-navigate the full workflow in
portrait/landscape; use the on-screen keyboard; open/cancel clipboard, share,
Storage Access Framework and camera; background/return; restart Chrome; resolve
a conflict and inspect revocation. Expected speech names role, action, current
state, fallback and irreversible consequence; alerts occur once and focus
returns from Android surfaces. Fail on lost order/focus, unlabeled controls,
color-only state, clipped 200% text or TalkBack actions that bypass confirmation.
Capture exact device/Chrome/TalkBack versions, transcript, focus order,
permission outcomes, evidence ID and cleanup. Current status: `not_exercised`.

## NVDA on Windows Chrome and Firefox

Starting state: supported Windows version, fresh browser profiles, synthetic
project, NVDA current stable. Use Tab/Shift+Tab, headings, forms and browse/focus
modes through setup, invitation, files, direct connection, conflict, revocation,
privacy and close. Confirm dialog boundary, single live-region announcements,
error focus, QR alternative, technical disclosure, project switching and 200%
zoom/forced colors. Repeat in each claimed browser; do not infer Firefox from
Chrome. Capture NVDA speech viewer output with artifacts redacted, focus order,
browser/OS versions, evidence ID and cleanup. Current status: `not_exercised`.

Only a qualified human review can change these manual rows to pass.

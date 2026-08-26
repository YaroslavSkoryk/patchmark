# HC-3 Slice 2: disabled manual workflow and browser ports

Status: implemented as isolated workflow, adapter, and qualification evidence

Production collaboration enabled: **no**

## Architecture and authority boundary

Slice 2 coordinates the existing HC-2 lifecycle without replacing any of its
authority. `Hc3DisabledManualWorkflow` owns only ephemeral prepared carriers,
selected file copies, safe previews, and user guidance. It injects:

- a reader that reopens portable, custody, invitation, membership, epoch,
  journal, and continuity evidence;
- existing HC-2 operations for invitation, enrollment, authorization, V2
  admission, V3 synchronization, and convergence;
- explicit browser capability ports; and
- the incremental SHA-256 implementation already required by the HC-2 bundle
  framing readers.

Construction invokes none of them. There is no timer, retry loop, watcher,
worker, storage listener, fragment handler, network request, or background
command. Every status and port record has `authority: "none"`. The HC-3
namespace remains outside the production collaboration barrel, and the
test-only surface exists only under `scripts/`.

The facade exposes these explicit command families:

1. readiness inspection and reopen reconstruction;
2. Invitation creation, copy, QR presentation, sharing, and preview;
3. enrollment start, Response creation/copy/share/preview, and authorization;
4. admission-file export, selection, preview, and confirmation;
5. Encrypted-update export, selection, preview, confirmation, and convergence
   inspection; and
6. cancellation of the current ephemeral selection or preview.

Preparation and preview commands never invoke an import. Mutation commands
read current evidence immediately before passing its revision to HC-2, then
read durable evidence again after HC-2 completes. A UI update is not treated as
proof that an operation committed.

## Preview and confirmation

Every inbound artifact crosses the same boundary:

1. An explicit paste or file-selection command supplies copied text or bytes.
2. HC-3 parses the canonical carrier or bounded V2/V3 framing.
3. Existing read-only HC-2 inspection derives a secret-free preview.
4. Current portable, custody, authority, epoch, and continuity evidence is
   reopened.
5. The facade presents a separate confirmation action.
6. Only that action invokes the authoritative HC-2 operation with the current
   evidence revision.
7. The result is reconstructed from durable evidence after reopen.

The preview says only what the artifact is for, its offered role when
appropriate, whether its structure is valid, whether it appears addressed to
the local device, its encrypted byte length, freshness/duplicate state, and
the next action. It does not claim that a sender is currently authorized,
membership exists, encryption establishes trust, or an update will be
accepted.

Ordinary guidance excludes keys, epoch plaintext, recovery material,
signatures, ciphertext, paths, handles, permissions, filenames supplied by the
platform, and editor state. A collapsed technical-details view may show only
opaque protocol identifiers and a secret-free diagnostic code.

Reload discards an ephemeral preview. Confirmation after reload therefore
requires explicit reselection and preview. Reload after an authoritative
commit reconstructs the next step from portable and IndexedDB evidence rather
than from presentation state.

## Presentation model

The strict states are `not_ready`, `ready`, `preparing`, `ready_to_share`,
`waiting_for_response`, `received_unverified`, `ready_for_confirmation`,
`processing`, `completed`, `cancelled`, `unsupported`, and `blocked`. Each has
a safe title, concise explanation, available explicit actions, artifact and
confirmation flags, recoverable/blocking classification, and an optional
secret-free diagnostic.

Corrupt or forked portable state, source-project mutation, ambiguous control,
epoch mismatch, revoked membership, or forked continuity produces `blocked`.
The presentation model is never persisted as truth and cannot be promoted to
an HC-1 event, HC-2 control record, membership, epoch, or transport receipt.

## Browser ports and fallbacks

Ports receive and return immutable copies and translate raw browser failures
to `success`, `cancelled`, `unsupported`, `permission_denied`, or `failed`.
They never call another workflow command.

| Capability | Explicit implementation | Fallback |
| --- | --- | --- |
| Clipboard | Secure-context `navigator.clipboard.writeText` only | Keep exact artifact for manual copy |
| QR | Injected presenter after Slice 1 single-QR eligibility | Copy or OS share; no QR dependency |
| Text/link share | `navigator.share` after an explicit action | Copy exact artifact |
| Encrypted-file share | Capability-probed share only | Save exact `.pmcb` file |
| Native save | Injected save picker and exact byte write | Explicit browser download |
| Browser download | Temporary object URL and opaque Slice 1 filename | Report unsupported/failure |
| Native open | Injected open picker with size check before full read | Manual paste is not used for encrypted bytes |
| Confirmation | Optional injected platform confirmation | The workflow still exposes its own separate confirm command |

Temporary object URLs are revoked in a `finally` path. Native cancellation and
permission denial are non-mutating. The selected byte array is copied before
inspection; extension and MIME values are hints only. The opaque filename is
derived from the exact bundle digest and never includes a project or person
name.

Desktop headless Chrome does not expose an OS share sheet or a QR provider in
qualification. Tests assert the typed unsupported/cancelled result and visible
copy/save fallback; they do not claim those platform capabilities ran.

## Manual invitation and enrollment sequence

The owner explicitly creates an HC-2 Invitation and HC-3 formats its exact
handoff. Copy, QR, and share can be retried without consuming it. The candidate
pastes and previews it, then explicitly begins the existing HC-2 enrollment
and possession ceremony. The candidate's Response remains two exact HC-3
carriers—signed enrollment request and possession proof—rather than a new wire
format. The owner previews both and explicitly authorizes the existing HC-2
membership transition. HC-2 CAS remains responsible for admitting at most one
competing consumption of an Invitation or challenge.

## Manual V2 admission

After owner authorization, the existing HC-2 exporter prepares exact encrypted
V2 bytes. The facade verifies framing, constructs the opaque `.pmcb` filename,
and calls the save port explicitly. A failed or cancelled save retains the
same bytes for retry. Candidate selection does not import. Preview requires V2
structure and current-recipient inspection; confirmation invokes the atomic
HC-2 V2 import. Durable reopen retains `full_history_verified: false` at the
candidate admission boundary. Exact duplicate confirmation is a no-op.

## Manual V3 synchronization

The existing V3 inventory, planner, dependency closure, exporter, importer,
session journal, receipt, acknowledgement, and convergence classifier remain
authoritative. Each bundle is saved, selected, previewed, and confirmed through
an explicit command. More work produces guidance for another bounded manual
exchange; no command schedules it. Completion requires a final explicit
exchange with zero object records and matching reconstructed authoritative and
projected state after both profiles reopen.

## Cancellation, retry, and failures

Cancellation clears only the current inbound selection or preview. Prepared
outbound artifacts remain byte-identical for retry. Clipboard, QR, share, save,
selection, and permission failures never invoke authority. Empty, oversized,
truncated, appended, mixed-version, wrong-recipient, wrong-project,
stale-control, stale-epoch, revoked-device, gap, replay, and fork evidence fails
closed with recovery guidance. Correct MIME with bad bytes fails; incorrect
MIME with valid bytes proceeds to actual structural and HC-2 verification.

## Accessibility qualification

The test-only surface uses native labelled textareas and buttons, a named action
group, a polite atomic status region, predictable focus movement after every
command, confirmation descriptions, and a collapsed technical-details
section. A 390 by 844 CSS-pixel Chrome viewport verifies the single-column
layout without horizontal overflow. Keyboard Space activation exercises the
same explicit facade command as pointer activation.

## Privacy and threat model

Threats include substituted or mixed artifacts, stale or revoked authority,
wrong recipient/project, invitation replay, stream gaps/replay/forks,
presentation-state corruption, browser permission loss, altered QR payloads,
partial download setup, and user confusion between encryption and trust. The
defenses are canonical Slice 1 carriers, exact V2/V3 framing, bounded copies,
HC-2 cryptography and CAS, revision revalidation, atomic import, durable reopen,
explicit confirmation, opaque filenames, and fail-closed guidance.

Physical recipients can retain artifacts they were already given, and
revocation cannot recall ciphertext. Manual exchange does not provide presence,
delivery, or freshness by itself. Those limitations are unchanged from HC-2.

## Qualification and deferred work

Chrome qualification composes the existing real two-profile HC-2 harnesses
with the HC-3 surface/port boundary. It proves isolated persisted
non-extractable keys, Invitation and possession CAS, V2 admission, receipt,
independent work, bounded V3 exchanges, duplicate no-ops, zero-record final
exchange, six reopen cycles, and equality across 19 authoritative/projected
state categories.

Slice 3 may add the next explicitly scoped no-cloud transport or product
integration work only after a separate architecture and security decision.
This slice adds no production route, component, menu, action, endpoint, URL
handler, protocol registration, feature flag, dynamic import, or network
capability.

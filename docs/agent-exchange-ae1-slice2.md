# Agent Exchange AE-1 Slice 2

Status: Patchmark-side product workflow qualified; production release remains disabled.

## Product workflow

In the explicit development qualification state, **Send to agent** appears in
the Comments rail immediately below the existing primary comment actions. The
same delivery action appears beside the existing manual action for a Guided
Review proposal and beside the exact-snapshot actions for an active Review
Batch. There is no permanent application-bar control, provider chooser, agent
dashboard, or settings surface.

The focused path continues to use `getFocusedCommentsForExport`. The guided
path continues to use `deriveReviewQueue` and
`validateGuidedReviewSessionSelection`. Both call the existing
`createTrackedReviewBatchExport` exactly once. An already-exported active batch
is delivered without another export. A synchronous re-entry lock prevents a
double-click, keyboard repeat, or concurrent handler from creating a second
batch. The committed prompt is then read once by `prepareAgentExchange`; one
connector and one operation are created only after that explicit action.

The compact UI reports Preparing review, Sending, Waiting for agent, response
ingestion, Agent response ready, bounded failure, and cancellation states. It
never displays request bytes, JSON, hashes, operation IDs, connector versions,
paths, or provider details. Sending/waiting exposes Cancel. Successful import
exposes **Review replies and suggestions**, which reopens the existing Comments
surface, activates the first batch comment, and focuses its existing card only
after the user invokes that action. A late completion never steals focus.

## Transport, import, and human authority

The UI constructs no connector, performs no availability check, hashes no
request, and generates no operation ID before Send. The operation checks
availability once, submits once, and performs no polling or automatic retry.
The distinct typed `waiting` phase begins after the connector accepts a
submission Promise and lasts until a response settles.

A bound response enters `importProjectCommentReplyResponseBytes`, the same
strict importer used by manual exchange. Parsing, Review Batch association,
comment scope, snapshot, dependency, atomic-table, replay, rollback, and
persistence semantics are unchanged. Replies appear in existing comment
threads. Suggestions appear as existing pending patch proposals. Agent
Exchange has no Accept/Reject API and never changes Markdown during import.
Only the existing human **Accept Patch** action changes Markdown; **Reject
Patch** changes proposal state without applying its text.

Successful imports report reply/suggestion counts but never imply changes were
applied. Reply-only, suggestion-only, and empty valid results use bounded copy
without inventing false work.

## Cancellation, failures, and manual fallback

Cancel uses the Slice-1 AbortSignal boundary. It makes the operation terminal,
prevents a deliberately late response from importing, and retains the current
Prepared Exchange for the page lifetime. Unavailability and connector
interruption report **Couldn’t reach agent**. Strict-import or persistence
failure reports **Agent response couldn’t be imported** and relies on the
existing atomic rollback. Ownership/binding failure reports that the response
no longer belongs to the active review. Raw connector/import errors are not
shown.

After cancellation or transport/import failure, **Use manual export instead**
decodes a copy from `operation.copy_manual_fallback_bytes()` (or the same
Prepared Exchange if operation construction itself failed) and opens the
existing manual prompt dialog. It does not export again, assign a new batch ID,
or regenerate current content. Normal manual export and manual response import
remain independently available.

## Lifecycle policy

Operation ownership lives in `DocumentEditor`, above the transient Comments
rail and Guided Review DOM. Closing a desktop rail or narrow modal does not
cancel the operation. Reopening shows the current sending/waiting/result state.
Async completion announces status but does not move focus.

Operations are transient and are not stored. Reload does not reconstruct,
resume, poll, or import an old operation. Existing persisted comments, Review
Batches, imported replies, proposal decisions, and manual context packs retain
their established persistence behavior.

The exchange is document-scoped. Selecting a different document invalidates
the operation before navigation work begins, aborts transport, clears its UI
status, and prevents commit-time import. Returning to the document does not
revive it. Loading another project does the same using captured project and
document identity, so neither data nor status can cross scope. Slice-1
generation ownership continues to reject superseded late operations.

## Accessibility and responsive behavior

All actions are native buttons with explicit accessible names. Status uses one
polite atomic `role=status` region. On initiation, focus moves predictably to
Cancel; after cancellation it moves to the remaining manual fallback. Failure
text is noninteractive and does not receive focus. The explicit review action
moves focus to the existing comment card. Existing Comments close/reopen focus
restoration and Guided Review focus trapping remain unchanged.

The surface is fluid, wraps actions and long bounded messages, and has no fixed
width. Qualification covers desktop, `390×844`, and a 200%-equivalent reflow
width without horizontal overflow or unreachable controls. Forced-colors rules
retain a visible border and focus indicator. Reduced-motion rules remove
transitions; no animation, rotating message, timer, or percentage is required
to understand progress.

## Release and provider boundary

The sole production release authority remains:

```ts
{
  human_collaboration: false,
  agent_exchange: false
}
```

`DocumentEditor` imports only the lightweight Agent Exchange entrypoint. The
product component, operation controller, Prepared Exchange implementation, and
injected driver are owned by `qualification-loader.ts`. When Agent Exchange is
false, the production bundler removes that loader edge. Production therefore
has no Send/status/fallback DOM, initial or lazy implementation chunk,
connector construction, Agent Exchange crypto/randomness/timer/worker/storage/
network work, or deterministic qualification connector. Human Collaboration
remains independently disabled and exposes no collaborator, QR, WebRTC,
storage, crypto, or network behavior when Agent Exchange qualification runs.

AE-1 Slice 2 still connects to no real provider. The deterministic browser
connector exists only at the injected non-production qualification seam.
Manual export/import remains supported, and agent output remains proposed work.
AE-2 should next investigate the current supported Codex local interface and
implement one bounded local bridge behind the already-qualified connector
contract; it must not speculate about endpoints or weaken Patchmark's import
and human patch-authority boundaries.

# Guided Review Phase 3: Guided Review Wizard

Phase 3 adds a document-scoped wizard around the deterministic Phase 1 queue
and the durable Phase 2 Review Batch transaction. It does not duplicate either
domain layer and does not analyze response completeness.

## Wizard flow

The **Guided Review** toolbar action opens one of four principal steps:

1. **Queue overview** shows authoritative Phase 1 lifecycle counts, concise
   explanations, blocked-comment re-anchor routes, and deferred-comment restore
   actions.
2. **Proposed batch** presents the current deterministic proposal, selection and
   exclusion reasons, comment details, live prompt estimates, and controlled
   transient adjustments.
3. **Active exported batch** identifies Guided Review or manual ownership and
   reuses Phase 2 exact prompt copy, context-pack open, import, and cancellation
   operations.
4. **Response received** confirms only that an exactly identified response was
   attached and routes the human back to comment review.

No-ready and blocked-only conditions are descriptive queue-overview states. An
empty Review Batch is never generated.

## Transient proposal session

Proposal adjustments are in-memory and bound to `project_id`, `document_id`,
document generation, the Phase 1 algorithm version, the Phase 1 proposal
signature, and a working-state fingerprint. The session records:

- base proposal comment IDs;
- final ordered comment IDs;
- transiently removed IDs;
- transiently added IDs;
- live estimated complete-prompt tokens.

Selected IDs are always returned to deterministic document order. Section
batches may add only ready comments from the same H2 bucket and remain subject
to the five-comment and 20,000-estimated-token limits. Follow-up and
whole-document proposals remain single-comment batches.

**Removing a comment changes only the current proposal. Deferring a comment
persistently removes it from Guided Review until the human restores it.**

Reset discards transient additions and removals and rebuilds the current Phase 1
proposal. It does not restore persisted deferrals.

## Deferred comments

The owning document store may contain:

```text
.patchmark/review-queue-overrides.json
```

The schema stores `schema_version`, `project_id`, `document_id`, and unique
deferred-comment entries containing `comment_id`, `deferred_at`, and an optional
reason. The file is optional until the first deferral.

Deferral and restoration use the document commit queue. They inherit generation
checks, temporary-file installation, commit-last ordering, last-known-good
recovery, ownership validation, corruption handling, and no-op suppression.
They do not write comments or patches. A defer override never resolves, deletes,
re-anchors, marks, or edits a comment.

Phase 1 precedence remains authoritative: resolved, active export, and blocked
states take precedence over deferred. Reopening a resolved comment reveals its
persisted deferral until the human explicitly restores it.

## Tracked export handoff

Before export, Phase 3 rederives the queue from the current working Markdown,
comments, patches, active-batch evidence, and persisted deferrals. It validates
the session identity, proposal signature, lifecycle eligibility, anchor state,
section membership, order, count, size, and one-active-batch rule.

The final selection is then passed to the existing Phase 2 transaction. The
context pack is written and verified first; the Review Batch record is committed
last. Guided batches may persist an audit-only `selection_adjustment` snapshot.
The exact committed context pack remains authoritative.

Opening the overview, preparing a proposal, removing or adding comments, resetting,
or closing the wizard performs no authoritative write.

## Safety and compatibility

- Switching documents closes the wizard and discards transient state. Async
  completion checks the original composite document identity.
- Current safely recovered Markdown participates in queue and prompt previews,
  but opening, previewing, deferring, or restoring does not save that Markdown.
- An unresolved recovery conflict or read-only recovery state blocks generation.
- Groups affect display context only; opening the wizard does not mutate group
  or collapsed-state metadata.
- Bookmarks do not affect queue priority and are not modified.
- Manual **Mark for ChatGPT** and manual cross-section exports remain available.
  A manual active batch appears in the same active-batch step.
- Exact prompt copy and reopen always read the saved Phase 2 context pack, even
  if the working document has changed.
- Cancellation keeps the context pack and deletes no document or review data.

## Accessibility and responsive behavior

Focus enters on the wizard close control. Escape closes when no operation is
busy, Tab is trapped inside the dialog, status changes use a live region, and
controls have descriptive text labels. The cancellation confirmation is an
`aria-modal` dialog with initial focus, Escape handling, and a focus trap.
Counts, details, and action rows collapse to one column on narrow viewports.

## Phase 4 handoff

Phase 3 intentionally does not add response completeness, partial-response
status, answer/reply/patch counts, clarification summaries, acknowledgment,
automatic next-batch progression, cross-document batching, semantic grouping,
automatic sending, patch acceptance, or comment resolution. Those remain Phase
4 or later concerns.


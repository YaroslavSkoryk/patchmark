# Bulk Comment Trash and Restore

Patchmark uses document-scoped Trash instead of permanent comment deletion.
Moving a comment to Trash preserves its ID, open or resolved status, thread,
anchors and re-anchor history, patch lineage and decisions, import provenance,
Review Batch history, and source metadata.

> Moving a comment to Trash hides its review records but never reverses Markdown changes already applied through accepted patches.

Permanent deletion, Empty Trash, retention timers, automatic purge, and
cross-document cleanup are explicitly deferred.

## Schema and compatibility

Active comments have no required Trash fields. A trashed comment adds:

```json
{
  "trashed_at": "2026-07-31T04:00:00.000Z",
  "trash_operation_id": "comment_trash_..."
}
```

Restoration removes those active Trash markers and records `restored_at`.
Existing comments without Trash metadata load as active. Opening an existing
project does not rewrite its comments or change its fingerprints; serialization
occurs only after a real mutation.

## Bulk selection

`Select comments` opens a transient mode in the active document. Selection keys
include `project_id`, `document_id`, and `comment_id`, and remain independent
from ChatGPT focus marks, Guided Review adjustments, editor text selection,
patch selection, bookmarks, and re-anchor state.

`Select all visible` selects only active comments represented by the current
search and open/resolved filter. Changing either filter clears the current
selection and announces that deterministic policy. Switching documents remounts
the document-scoped panel and clears selection mode.

Opening selection mode, selecting or clearing comments, opening the confirmation,
and cancelling create no authoritative writes.

## Confirmation and blockers

The confirmation is recalculated from current authoritative records and reports:

- selected comments and replies;
- pending, accepted, rejected, and stale patches;
- anchored and unresolved comments;
- document-level comments;
- Review Batch relationships;
- blocked comments.

Accepted patches show the explicit warning that already-applied Markdown changes
remain.

The entire operation is blocked when any selected comment:

- belongs to an exported Review Batch awaiting ChatGPT;
- is in the active human re-anchor session;
- owns an unsaved comment, reply, or reply-edit draft.

Patchmark never cancels an active Review Batch, discards a draft, or moves only
the unblocked subset.

## Atomic persistence

The domain operation validates project and document identity, duplicate IDs,
comment existence, active Trash state, blockers, and a selection fingerprint
captured by the confirmation. It then creates one next comments collection.

The UI submits that collection through the existing generation-ordered document
write queue with LKG protection and rollback enabled. The Trash transaction
passes neither Markdown nor patches to persistence. On failure, the previous
comments and save commit remain authoritative, no partial Trash state is
reported, and the transient selection remains available to retry.

## Active-state exclusion

Trashed comments are excluded from:

- active comment cards, search, counts, rail positioning, highlights, and Find;
- manual ChatGPT focus/export projection;
- Guided Review classification, counts, and proposals;
- pending patch review entry points;
- automatic anchor convergence and document-edit anchor transformations.

Their comments, replies, patch records, dependencies, imports, historical Review
Batches, and anchor history remain stored. Reading bookmarks, groups, archive
state, missing-file Locate behavior, browser recovery, snapshots, and Version
History remain independent.

## Trash and restore

The collapsed `Trash · N` section shows each comment separately with its ID,
original open/resolved status, text, current anchor status, reply count, patch
count, Trash timestamp, and Restore action. Trash sorting is:

1. most recently trashed;
2. original document order;
3. `comment_id`.

One comment or several selected Trash comments can be restored in one atomic
comments-store commit. Restoration keeps the same ID, status, thread, patches,
provenance, and document ownership. It does not reapply accepted patches,
regenerate pending patches, modify Markdown, or create a Markdown Version
History entry.

After restoration, normal anchor projection evaluates the preserved anchor
against current Markdown. A valid anchor returns to highlights, Find, and rail
positioning. A stale or ambiguous anchor returns as an active unresolved comment
and uses the existing human re-anchor workflow. Document-level comments restore
without text-anchor validation. Guided Review derives fresh lifecycle state from
current authoritative history rather than forcing a restored comment to Ready.

## Accessibility and responsive behavior

Selection controls use descriptive labels and full-size targets. Selected counts
and filter-clearing notices use live status text. The confirmation is a modal
dialog with initial focus, Tab containment, Escape cancellation, explicit
blocked reasons, and focus return. Bulk bars and Trash controls stack at narrow
viewports and do not depend on hover or color alone.

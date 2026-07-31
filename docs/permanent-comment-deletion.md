# Permanent Comment Deletion

Patchmark has two distinct deletion stages:

```text
Active comment
→ Move to Trash
→ Restore or Delete forever
```

Trash is reversible soft deletion. Delete Forever removes the comment’s
restorable content from the active Patchmark document store. It does not undo
accepted Markdown changes or erase copies already present in exports,
imported-response archives, backups, or external systems.

## Scope

Permanent deletion is scoped to the active `project_id + document_id`.
`comment_id` is document-local, so the same local ID in another document is
never affected.

The available destructive actions are:

- **Delete forever** for one trashed comment.
- **Delete selected forever** for a Trash selection.
- **Empty Trash for _Document Title_** for every trashed comment in the active
  document.

Active comments have no direct permanent-delete action. They must first move to
Trash.

## Removed content

One atomic document-store generation removes:

- the comment prose, status record, export focus state, and Trash metadata;
- replies and reply edit history;
- anchors, selected text, context excerpts, and re-anchor history;
- comment patch-impact records;
- all linked pending, rejected, stale, and accepted patch proposal records;
- patch proposal original/suggested text, reasons, risks, sources, applied-text
  metadata, and dependency data;
- the comment’s Guided Review defer override;
- transient UI selection, navigation, re-anchor, reply, and patch-review state.

Search, Active, Trash, Find, the rail, highlights, Guided Review, manual export,
and unresolved-anchor lists derive from the remaining authoritative records, so
the deleted comment no longer appears in them.

## Minimal tombstones

The document manifest retains one content-free tombstone per permanently
deleted comment:

```json
{
  "schema_version": 1,
  "project_id": "prj_...",
  "document_id": "doc_...",
  "comment_id": "PM-COMMENT-0045",
  "permanently_deleted_at": "2026-07-31T08:00:00.000Z",
  "permanent_delete_operation_id": "comment_delete_...",
  "original_status": "open",
  "had_accepted_patches": true,
  "patches": [
    {
      "patch_id": "PM-PATCH-0012",
      "status": "accepted"
    }
  ]
}
```

Tombstones contain identifiers, statuses, ownership, and deletion timing only.
They do not retain comment prose, reply prose, selected text, anchor excerpts,
patch proposal text, reasons, risks, sources, URLs, or a hidden restoration
payload. Patchmark offers no Undo after permanent deletion.

## Markdown and Version History

Permanent deletion never writes `document.md`, reverses an accepted patch,
creates a compensating patch, or creates a Markdown snapshot. Accepted changes
remain byte-identical in the current Markdown.

Existing Version History and historical Markdown snapshots are not rewritten.
A tombstone preserves the accepted patch ID without preserving its proposal
content.

## Review Batches and imports

Historical Review Batches remain unchanged:

- ordered comment IDs and expected counts remain intact;
- response-analysis totals remain intact;
- import IDs, prompt fingerprints, response status, and acknowledgment status
  remain intact;
- historical UI shows `Permanently deleted` instead of reconstructing prose.

Exact committed context packs and raw imported-response artifacts remain
byte-identical. When a historical response references a deleted comment,
Patchmark warns that the exact pack or response may still contain the original
content.

Previously downloaded Markdown, JSON, prompt, and PDF exports are external
copies and are not modified.

## Confirmation

Confirmation is trimmed and case-sensitive:

- one comment: `DELETE`;
- multiple selected comments: `DELETE N COMMENTS`;
- Empty Trash: `EMPTY TRASH`.

The destructive button stays disabled until the exact phrase matches.
Cancellation performs no authoritative write.

## Blockers

Patchmark revalidates blockers immediately before mutation and blocks the whole
operation when any selected comment has:

- an active exported Review Batch awaiting ChatGPT;
- an in-flight response import;
- an in-flight Trash, Restore, or re-anchor mutation;
- an unsaved local comment or reply draft;
- a corrupt historical patch or Review Batch reference that cannot be
  represented safely;
- a patch in another comment that unexpectedly depends on a patch being
  removed.

Empty Trash never deletes an eligible subset when another Trash item is
blocked.

## Atomic persistence

The domain operation validates document ownership, duplicate IDs, Trash state,
confirmation scope, blockers, historical references, and a stale-selection or
stale-Trash fingerprint before creating output.

Comments, linked patches, defer overrides, and manifest tombstones then commit
once through Patchmark’s generation-ordered save coordinator with Last Known
Good recovery and rollback enabled. A failed write leaves comments and patches
in Trash and writes no partial tombstone.

## Unchanged state

Permanent deletion does not modify:

- Markdown or reading bookmarks;
- Version History or historical snapshots;
- project resume and browser Markdown recovery records;
- document groups, archive state, or file locations;
- another document or same-ID comment in another document;
- exact context packs or raw imported responses.

Locate and supported archived-document flows retain the owning document
manifest, including tombstones.

## Privacy limits and non-goals

Delete Forever is permanent only inside the active Patchmark document store.
Previously exported prompts, imported-response archives, downloaded files, Git
history, Time Machine or filesystem backups, copied projects, PDFs, and external
ChatGPT conversations may still contain copies.

This phase does not implement universal erasure, backup deletion, context-pack
rewriting, raw-import rewriting, Git-history rewriting, retention timers,
automatic purge, project-wide Empty Trash, cross-document deletion, accepted
patch rollback, historical Markdown rewriting, or Undo. A future full-purge
workflow would need explicit policy and handling for every immutable and
external artifact.

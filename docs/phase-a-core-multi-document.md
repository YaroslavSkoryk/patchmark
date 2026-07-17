# Phase A-Core Multi-Document Foundation

## Model

Patchmark projects now support an explicit collection of registered Markdown
documents. Markdown remains authoritative and portable. Patchmark metadata is
split into three boundaries:

1. `.patchmark/project.json` contains the portable project registry.
2. Each registered Markdown path remains relative to the project root.
3. `.patchmark/documents/<document_id>/` contains that document's review and
   persistence state.

Device-local editor state is stored in browser local storage under the immutable
`project_id` and `document_id`. Switching documents or scrolling does not mutate
portable project files.

## Project Registry

`.patchmark/project.json` has format `patchmark-project`, schema version `1`, an
immutable locally generated `project_id`, a title, a monotonic
`manifest_revision`, and explicit document records.

Each document record contains:

- immutable `document_id`;
- safe project-relative Markdown `path`;
- Patchmark-only `display_title`;
- optional informational `role` (`decision`, `research`, `evidence`, or
  `summary`);
- `active` or `archived` lifecycle status;
- sparse sortable `position`;
- added and archived timestamps.

`missing` is not persisted as a lifecycle status. It is calculated from the
registered path at runtime.

Registry revisions advance only for registry mutations: create, add existing,
title, role, reorder, archive, restore, and Locate file. Markdown edits, review
objects, versions, cursor state, and document switches do not rewrite
`project.json`.

Registry writes preserve a last-known-good copy in
`.patchmark/recovery/project.json.lkg`, verify a temporary candidate, and install
the validated manifest last. A valid `project.json` is the multi-document format
commit marker.

## Document Stores

Every document store contains `document.json`, which binds the directory to one
immutable `document_id`. Patchmark verifies this ownership before loading the
store, so review objects cannot be loaded through another document's storage
boundary.

The remainder of each store deliberately reuses the proven single-document
generation engine:

- `manifest.json` and `save-commit.json` retain generation and commit identity;
- `comments.json` and `patches.json` retain IDs, lineage, anchors, repair history,
  replies, and status;
- `versions/`, `recovery/`, `context-packs/`, and `imports/` remain scoped to the
  owning document;
- last-known-good recovery and temporary-file cleanup run independently per
  document.

An internal directory-handle adapter maps the existing engine's logical
`document.md` and `.patchmark/` paths to the registered Markdown file and its
document store. This avoids a parallel persistence implementation and means one
document's save generation cannot advance another document's generation.

The internal per-document `manifest.json` still names logical `document.md` for
compatibility with the existing atomic engine. The project registry is the source
of the real relative Markdown path.

## Legacy Compatibility

Opening a legacy project reads the original layout and performs no migration
writes. Normal legacy work continues unchanged.

Conversion is triggered only by explicit conversion or by creating/adding a
second document. The migration follows this sequence:

```text
Legacy
→ Preflight
→ Staging
→ Verified
→ Document store committed
→ project.json committed last
→ Reopened through multi-document loading
→ Complete
```

Preflight loads current comments, patches, anchors, lineage, versions, and
generation metadata and records object counts. Staging recursively copies legacy
metadata without rewriting unknown fields. Verification compares every copied
file byte-for-byte and checks IDs and comment-to-patch ownership. The final
document store is verified before `project.json` is installed.

The original legacy Markdown and metadata remain untouched as a recovery source,
but Patchmark does not dual-write them after conversion. All subsequent document
work goes through `.patchmark/documents/<document_id>/`.

Migration journals live in `.patchmark/migrations/`. A pre-commit failure leaves
no valid project manifest, so legacy remains authoritative. If a crash occurs
after manifest commit, the next open validates the committed candidate and marks
the migration complete. If that pending candidate cannot reopen, Patchmark
quarantines its manifest under `.patchmark/recovery/`, removes the invalid commit
marker, and reopens the untouched legacy project.

## Create and Add Existing

Create document validates title and path, creates the Markdown file without
overwriting an existing file, stages and verifies an empty document store, commits
that store, and updates the project registry last. A failure can leave an
unregistered Markdown file or orphan store, but never an authoritative registry
entry pointing to an incomplete document.

Add existing accepts only regular `.md` or `.markdown` files that the browser can
prove are inside the selected project root. It rejects traversal, `.patchmark`,
duplicates (including portable case-insensitive collisions), directories,
outside files, and symbolic links. The Markdown bytes are checked before and after
registration and are not modified.

## Switching and UI State

The editor keeps one active document. Switching performs a complete active
document save barrier before loading the target store. If persistence fails, the
current document remains active and the target is not applied. A monotonically
increasing request token prevents a stale asynchronous load from replacing a
newer selection.

Mode, Markdown selection, scroll position, and preferred active document are
restored per `project_id` and `document_id` from device-local browser storage.
Submitted comments and patches use normal document persistence. Temporary visual
selection remains ephemeral. If a comment or reply composer is still open,
Patchmark asks for confirmation before discarding that unsubmitted draft during a
document-changing operation.

## Archive and Missing Files

Archive changes registry metadata only. Markdown, comments, patches, versions,
and recovery files remain untouched. Restore preserves the same `document_id`.

Missing files remain registered and appear with a Missing file badge. Other
documents continue to work. Locate file validates a user-selected replacement
inside the project root, updates only the registered relative path, and retains
the same document store and identity.

## Exports and History

Prompt payloads identify the active project and document by title, role, relative
path, and stable IDs. Context packs and imported responses are written through
the active document store. PDF preview captures the active document ID, filename,
and Markdown when export begins, so a later switch cannot retarget that preview.
Version History reads only the active document's internal manifest and versions
directory.

No project-wide prompt, PDF bundle, snapshot counter, or history list is created.

## Phase A Non-Goals

This phase does not add cross-document references, backlinks, relationships,
contradiction detection, automatic propagation, cross-document patches,
project-wide snapshots or prompts, multi-document tabs, external linked files,
automatic Markdown discovery, role inference, detach/remove, or file deletion.

Roles are labels only. A research conclusion cannot modify a decision document or
create a patch for it automatically.

Phase A.1 adds copy-based assembly from multiple legacy projects. Its source
immutability, collision, provenance, transaction, and recovery rules are
documented in
[`phase-a-1-legacy-project-assembly.md`](phase-a-1-legacy-project-assembly.md).

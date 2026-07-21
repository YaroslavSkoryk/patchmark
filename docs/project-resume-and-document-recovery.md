# Project Resume and Document-Scoped Crash Recovery

Patchmark keeps project resume, unsaved Markdown recovery, and project integrity
recovery as separate systems.

> Resuming opens the authoritative local project. Browser recovery only protects
> unsaved Markdown editor content for a verified project document.

## Previous Browser-Draft Behavior

Before this change, every loaded Markdown buffer used the same filename-only
localStorage namespace:

```text
patchmark:draft:<encoded filename>
```

Each value contained only:

```json
{
  "fileName": "document.md",
  "markdown": "...",
  "updatedAt": "2026-07-21T03:39:00.000Z"
}
```

The editor wrote this record synchronously after every Markdown state change.
Project documents and standalone files shared the namespace. Equal filenames
overwrote one another.

`Restore draft` loaded the Markdown into a detached editor buffer, removed the
active project and file handle, and set no saved baseline. It did not validate a
project, document, folder, or standalone file and did not immediately write a
file.

`Discard draft` removed the filename key from localStorage. It did not write a
file, but the UI could not establish which project or file the key represented.

That path is no longer used to capture or restore working Markdown.

## Three Recovery Systems

### Project resume

Project resume stores device-local navigation metadata and, where the browser
supports it, a structured-cloneable directory handle. Resume opens the existing
folder through the normal project loader, validates project identity, chooses the
last active available document by stable ID, restores device-local UI state, and
only then evaluates unsaved recovery.

Resume never reconstructs a project from browser data.

### Unsaved editor recovery

Unsaved recovery stores dirty Markdown for one verified owner. Recovered content
is loaded as a dirty working buffer and must pass through the normal Save Changes
pipeline before it reaches disk.

Browser recovery does not store or repair comments, replies, patches, anchors,
bookmarks, snapshots, Version History, manifests, save commits, or generations.

### Project integrity recovery

The existing atomic save, temporary-file validation, transaction journal,
last-known-good, migration rollback, and project recovery UI remain authoritative
for interrupted or invalid project state. Browser Markdown recovery is never
used to reconstruct metadata or complete an interrupted project transaction.

## Device Storage

Device state uses IndexedDB database `patchmark-device-state`, schema version 1,
with separate object stores for:

- local project instances;
- local standalone-file instances;
- document recovery records.

Markdown recovery is not stored in localStorage and is not synchronously written
on each keystroke. Dirty buffers are captured with a debounce and receive a
best-effort update on page hiding or suspension.

IndexedDB or SHA-256 failures are not reported as a successful recovery
guarantee. They do not replace the normal save pipeline.

All data remains on the local browser/device. Patchmark does not send recovery
content to a server, analytics, telemetry, ChatGPT, or another API.

## Portable and Local Identity

Portable project-document identity remains:

```text
project_id + document_id
```

Those IDs stay in the portable project folder and are not changed for recovery.

Copied project folders can intentionally retain equal portable IDs. Patchmark
therefore assigns each opened local folder association a device-only ID:

```text
local_project_<random UUID>
```

A recent-project record contains:

```json
{
  "schema_version": 1,
  "local_instance_id": "local_project_...",
  "project_id": "prj_...",
  "project_title_snapshot": "Strategy",
  "last_document_id": "doc_...",
  "last_document_title_snapshot": "Ready-to-Eat Channel Research",
  "last_group_id": "grp_...",
  "last_opened_at": "2026-07-21T03:39:00.000Z",
  "directory_handle": "stored by IndexedDB where supported"
}
```

Stable IDs are authoritative. Titles and group IDs are display/navigation
snapshots. The local instance ID and directory handle are never written into the
portable project manifest or project folder.

## Directory Handles and Permission

When a stored native directory handle remains usable:

1. Patchmark queries read/write permission.
2. A `prompt` state requests permission only from the Resume button gesture.
3. The normal project loader opens the folder.
4. The loaded `project_id` is compared with the recent-project record.
5. The last active available `document_id` is opened when it still exists.
6. Device UI state and document recovery are evaluated.

When permission is denied, the handle is unavailable, or a test/non-native
handle cannot be restored, the UI says `Reopen <project> folder` and invokes the
normal folder picker.

If both handles support `isSameEntry`, Patchmark uses it to confirm the same
local filesystem entry. If handle identity cannot be established and document
recovery exists, the user must explicitly confirm the copied-project ambiguity.
The selected folder must still match `project_id`, and each recovery must still
pass document ID and base-content validation.

An unrelated project ID is rejected. Cancelling or failing folder access keeps
the recent-project record and recovery records intact.

## Project Document Recovery Record

A project-owned record is keyed by:

```text
local_instance_id + project_id + document_id
```

Its recovery ID is a namespaced encoding of those three values. The record is:

```json
{
  "schema_version": 1,
  "owner_type": "project_document",
  "recovery_id": "project:local_project_...:prj_...:doc_...",
  "local_instance_id": "local_project_...",
  "project_id": "prj_...",
  "document_id": "doc_...",
  "project_title_snapshot": "Strategy",
  "document_title_snapshot": "Ready-to-Eat Channel Research",
  "group_title_snapshot": "Crust Chant",
  "base_content_sha256": "...",
  "base_document_generation": 72,
  "recovered_content_sha256": "...",
  "markdown": "...",
  "created_at": "...",
  "updated_at": "..."
}
```

Filename, title, heading text, comments, bookmark IDs, and group IDs are not
recovery ownership keys.

Moving a document between groups, renaming a group, removing a group, or changing
a display title does not change recovery identity. The current manifest supplies
the group and title shown when recovery is reviewed.

## Capture and Switching

A recovery record exists only while working Markdown differs from the latest
successfully persisted Markdown baseline.

Capture occurs:

- after meaningful Markdown changes through a 500 ms debounce;
- before page hiding or lifecycle suspension where the browser permits;
- before save/document-boundary operations as a best effort.

The existing document switch sequence remains:

```text
persist active Markdown and document stores
→ unload active document
→ load target document
→ restore target device-local state
```

The browser buffer is only a fallback. A failed project save prevents switching,
keeps the current document active, and leaves its scoped recovery available.
Recovery writes capture immutable project/document IDs, and load request tokens
prevent stale asynchronous completion from being applied to a newer document.

## Content-Hash Decisions

Patchmark validates the record's recovered-content hash and calculates SHA-256
for current saved Markdown.

### Safe recovery

```text
saved hash == recovery base hash
```

The saved file has not changed since capture. Patchmark loads recovered Markdown
as the dirty working copy, shows project/group/document context, and performs no
file write. Save Changes uses normal mutation orchestration and atomic project
persistence.

### Already saved

```text
saved hash == recovered working hash
```

The browser record is stale because disk already contains the working content.
Patchmark deletes the browser record and shows no recovery warning or redundant
write.

### Conflict

```text
saved hash != recovery base hash
saved hash != recovered working hash
```

Patchmark keeps current saved Markdown in the editor, shows both versions for
review, and never merges or overwrites automatically.

`Use recovered changes as working copy` requires confirmation and loads recovered
Markdown as dirty state only. `Keep saved document` requires confirmation and
deletes only that recovery record.

An invalid recovered-content fingerprint is handled conservatively through the
same non-automatic conflict review path.

## Clearing Records

A scoped recovery record is deleted only after:

- normal Save Changes successfully persists matching working Markdown;
- saved Markdown is proven byte-equivalent to recovered Markdown;
- the user explicitly discards recovery for that exact owner;
- the user explicitly deletes all device-local data for the recent local project
  instance.

Discard never writes or changes:

- Markdown files;
- project manifests;
- comments or replies;
- patches or patch groups;
- anchors or re-anchor history;
- bookmarks;
- snapshots or Version History;
- document-store identities, save commits, or generations.

After a project recovery discard, comments and patches are reread from the
authoritative document store so temporary working-text transformations do not
survive in memory.

Closing a project, opening another document, losing permission, renaming files,
or moving groups does not clear recovery.

## Multiple Documents, Missing Files, and Archives

Each recovered document has an independent record. The resume card reports a
count, and the project navigator marks documents with `Unsaved recovery`.
Discarding or saving one record leaves all others unchanged.

If a registered Markdown file is missing, Patchmark preserves the recovery and
shows the document-specific missing recovery state. The existing Locate workflow
must validate and repair the registered path. Filename equality never selects a
replacement.

Archived documents remain archived. Their navigator entry can show recovery, but
the user must explicitly restore the document before opening and evaluating it.

## Groups and Bookmarks

Resume restores the last document by `document_id` and derives its current group
from the manifest. Existing navigator behavior expands the owning group locally
without changing manifest state.

Bookmark navigation remains document-scoped. A bookmark-triggered switch waits
for project/document load and recovery evaluation before navigating to the reading
anchor. Recovery never uses bookmark IDs or text as identity.

## Device-Local UI State

Mode, Markdown selection, scroll position, and active comment state are stored in
localStorage under a local-instance/project/document key. Existing collapsed-group
state remains device-local. State is persisted before safe boundaries and on page
hiding where supported.

Device UI state never changes the portable project manifest.

## Standalone Markdown Files

Standalone files use separate local-file instances and recovery IDs:

```text
owner_type: standalone_file
standalone:<local_file_id>
```

Patchmark associates the local-file instance through `FileSystemFileHandle`
identity (`isSameEntry`) where available. A project document and standalone file
with the same filename cannot share or receive each other's recovery.

If the browser cannot persist or re-identify the same standalone handle, Patchmark
does not use filename as a fallback. The user must reopen the file and establish
safe handle identity before scoped recovery can be evaluated.

## Legacy Filename-Only Records

Existing `patchmark:draft:*` localStorage records are classified as legacy
unscoped recovery. Patchmark:

- stops creating them;
- does not show generic Restore/Discard actions;
- never binds them to a project or standalone file by filename;
- preserves them until explicit cleanup;
- shows filename and timestamp only as untrusted hints;
- allows copying or downloading Markdown for manual inspection;
- allows explicit deletion of the browser record.

Copy, download, and cleanup do not modify project files.

## Privacy and Authority

The project folder remains authoritative for saved Markdown and Patchmark review
state. Browser storage is a temporary, device-local safety net for unsaved
Markdown only. It is not a second project database and is not portable with the
project.

## Non-Goals

This implementation does not add cloud backup, cross-device sync, server drafts,
project reconstruction, deleted-folder recovery, automatic merge, CRDTs,
collaboration, group-level drafts, project-wide drafts, filename-based document
identity, automatic legacy-draft application, or browser recovery of comments,
patches, anchors, bookmarks, snapshots, or Version History.

## Browser Limitations

- File System Access handle persistence and permission APIs vary by browser.
- Native Chromium handles can be structured-cloned through IndexedDB; synthetic
  test handles and unsupported browsers may require folder reselection.
- Lifecycle events provide only best-effort time for asynchronous IndexedDB
  writes. The existing unload warning and normal save barrier remain important.
- Patchmark does not automatically merge independently changed Markdown.

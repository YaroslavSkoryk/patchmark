# Phase A.1 Legacy Project Assembly

## Purpose

Phase A.1 creates one new multi-document Patchmark project from two or more
supported legacy single-document projects. It copies each source document and
its complete review store into a separate destination document store. It does
not merge Markdown bodies, comment threads, patches, or Version Histories.

The user-facing action is **Create Project From Existing Patchmark Projects**.
The resulting destination is an ordinary Phase A-Core project, not a permanent
assembly-specific project subtype.

## Assembly Versus Conversion

Phase A-Core conversion upgrades one legacy folder in place. Phase A.1 assembly
creates a separate destination and never converts a source:

| Conversion | Assembly |
| --- | --- |
| One legacy source | Two or more legacy sources |
| Reuses the source folder | Requires an empty destination folder |
| Source becomes multi-document | Sources remain legacy projects |
| One new `document_id` | One new `document_id` per source |
| Commits `project.json` in the source | Commits `project.json` only in the destination |

Both paths use `inspectLegacyProjectImportSource` as the low-level legacy reader.
It validates required legacy files, rejects multi-document sources and reserved
ownership files, preserves unknown metadata files, and supplies the source
snapshot used to create a document-owned store. The established one-project
conversion continues to use its copy-first, verify-first, manifest-last flow.

## Supported Sources

The assembly flow accepts local folders that:

- are legacy single-document Patchmark projects;
- contain `document.md`, `.patchmark/manifest.json`, `comments.json`, and
  `patches.json`;
- load through the normal legacy compatibility loader in strict read-only mode;
- have a current authoritative persistence state or a verified last-known-good
  generation that the compatibility loader can recover;
- contain safe Version History paths and valid referenced snapshot hashes;
- contain no `.patchmark/project.json` or multi-document store directory.

Multi-document projects, arbitrary Markdown files, source moves, source
conversion, and importing into an existing destination are not supported.

The normal loader previously cleaned stale temporary files during open. Source
preflight explicitly uses its read-only option, which disables that cleanup and
therefore makes validation non-mutating.

## Source Preflight

`inspectLegacyProjectAssemblySource` performs these steps:

1. Enumerates the complete source tree and hashes every file and directory
   listing.
2. Runs the shared low-level legacy reader.
3. Opens through the current legacy compatibility loader in read-only mode.
4. Loads and normalizes comments, replies, patches, anchors, histories, versions,
   and persistence generation state. If current state is incomplete, a verified
   last-known-good generation becomes the destination's active generation while
   questionable current files are retained under
   `recovery/imported-questionable-current/`.
5. Reads every registered snapshot and validates optional SHA-256 values.
6. Inventories collision-sensitive identities.
7. Detects unknown top-level legacy fields and reports that they will be
   preserved.
8. Re-enumerates and re-hashes the complete source tree to detect concurrent
   changes.

Preflight records Markdown bytes and SHA-256, complete source-tree SHA-256,
object counts, generation, imported file count, and imported byte count. A
source is re-hashed immediately before its copy, before manifest commit, and
after destination reopen.

Legacy stores can contain historical links to objects no longer present, such
as a decided patch whose comment was deleted. The normal compatibility loader
accepts these records. Assembly preserves them byte-for-byte and shows a warning
instead of inventing a tombstone or rewriting lineage.

## Identity and Collision Rules

Every operation generates a random new `project_id` and random new
`document_id` values. These identities are not derived from paths, names, or
source hashes.

Existing document-scoped IDs remain unchanged, including comments, patches,
versions, patch groups, imports, reply records, and identified anchor-history
records. Reply and anchor-history identity is parent-scoped because the current
legacy model permits the same reply/history ID under different comments.

Phase A.1 originally failed closed on cross-source duplicates in these
namespaces:

- comments;
- parent-scoped replies;
- patches;
- versions/snapshots;
- parent-scoped anchor histories;
- patch groups;
- source imports.

That rule was too strict for the Phase A-Core storage model: every imported source
becomes a different verified document store. Phase A.2 therefore classifies equal
local IDs in different destination documents as **allowed document-local
duplicates**. The assembly review reports these separately from unsafe
same-document or project-scoped collisions. Local IDs are not remapped.

Same-document duplicates remain invalid. Missing ownership, genuinely
project-scoped collisions, ambiguous project-level registries, and any semantic
verification failure continue to block manifest commit. Destination paths remain
subject to the Phase A-Core portable path rules, including case-insensitive
duplicate detection.

The baseline two-folder Crust Chant audit contained six duplicate comment IDs:
`PM-COMMENT-0005`, `0008`, `0011`, `0013`, `0014`, and `0015`. Phase A.2
classifies all six as safe document-local duplicates, reports zero unsafe
collisions, and assembles the pair without changing either source. The executable
real-project audit requires these six as a stable subset and reports any newer
document-local duplicates separately. Automatic ID remapping remains a non-goal.

## Immutable Import Plan

`createLegacyProjectAssemblyPlan` verifies source uniqueness, source/destination
separation, containment, destination emptiness, portable paths, roles, and all
unsafe identity collisions before returning a frozen plan. The plan contains new
project/document identities, source labels and hashes, destination paths,
display titles, roles, and sparse positions.

Runtime handles remain only in memory. Neither the project manifest, document
ownership record, provenance record, nor assembly journal stores an absolute
source path.

## Transaction and Commit Marker

Browser File System Access does not provide a portable atomic sibling-directory
rename. Phase A.1 therefore requires an empty destination and uses
`project.json` as the final commit marker:

```text
Preflight
→ Create .patchmark/transactions/<assembly_id>/assembly.json
→ Revalidate and copy each source
→ Write destination Markdown bytes
→ Write document-owned review stores
→ Add document.json ownership and import-provenance.json
→ Verify every copied byte and ownership record
→ Revalidate all source hashes
→ Commit .patchmark/project.json last
→ Reopen through the ordinary project loader
→ Load and verify every imported document and Version History
→ Revalidate all source hashes
→ Mark complete and remove the transaction journal
```

Markdown and metadata files are read and written as bytes through native file
handles. JSON metadata must still be valid UTF-8 because Patchmark's persistence
formats are textual. Newline style and UTF-8 byte content are preserved. Empty
metadata directories are recreated as part of the copied store.

Every store receives:

- `document.json` with the new destination `document_id` and source type
  `legacy-assembly`;
- `import-provenance.json` with source label, source project name, content
  hashes, assembly ID, and import timestamp.

Provenance is diagnostic only. It is not used for identity, synchronization, or
future writes.

## Failure and Recovery

A caught failure at any transaction boundary removes the valid manifest first
and then removes all generated destination entries. Because the destination was
proven empty before the first write, deterministic cleanup cannot delete
pre-existing user content. Sources are never cleanup targets.

If the process terminates before manifest commit, the destination contains a
transaction journal but no valid `project.json`. Selecting that folder again in
the wizard detects the incomplete operation. Patchmark offers **Clean Incomplete
Assembly** only when every remaining entry is proven to be a path generated by
the journal. Unexpected files disable automatic cleanup and require manual
review.

If the process terminates after manifest commit but before completion, normal
project open detects the pending assembly journal. It reopens every document,
loads comments and patches, reads every Version History file, marks the journal
complete, and removes it. If this validation fails, Patchmark removes
`project.json`, marks the journal `invalid_destination`, and refuses to present
the folder as a valid project.

## User Flow

The existing project toolbar opens a three-step modal:

1. **Sources** — add two or more folders and review validated counts, generation,
   warnings, safe document-local duplicate counts, and unsafe collision status.
2. **Configure** — choose project title and empty destination; set every display
   title, destination filename, optional role, and order.
3. **Review** — confirm aggregate comments, replies, patches, versions, paths,
   roles, safe duplicate classification, zero unsafe collisions, and the
   source-immutability guarantee before commit.

Specific validation and collision errors remain in the modal. On success, the
destination is handed to the normal Phase A-Core loader and navigator.

## Isolation and Portability

The destination owns real copies. Editing its Markdown, comments, patches, or
versions writes only through destination-scoped handles. Moving or copying the
destination does not require either source path. Deleting the destination does
not affect a source.

Prompt generation reads only the active destination document store. PDF export
captures an immutable target containing explicit `document_id`, filename, and
Markdown when export starts; later document switching does not change the open
preview. Version History remains per-document and reads only that document's
copied `versions/` directory.

## Non-Goals

Phase A.1 does not implement content merging, thread merging, combined Version
History, multi-document sources, document selection from a multi-document
source, automatic ID remapping, deduplication, source deletion, source
conversion, linked source synchronization, importing into an existing project,
cross-document references, coordinated patches, cloud sync, or collaboration.

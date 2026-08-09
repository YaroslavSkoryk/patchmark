# Phase A.2 Document-Scoped Identity Compatibility

## Invariant

Every document-owned object is resolved through its verified owning document.
For a comment or patch, project-wide identity is:

```text
(document_id, local_id)
```

Legacy local IDs remain unchanged. Equal local IDs in different documents are
valid and are never remapped merely to appear globally unique.

## Identifier Inventory

| Identifier | Scope | Notes |
| --- | --- | --- |
| `project_id` | Project | Stable project owner; globally constrained in the project model. |
| `document_id` | Project | Unique registry/store owner inside a project. |
| Assembly transaction ID | Project | Coordinates one manifest-last assembly. |
| Project manifest revision | Project | Monotonic registry revision. |
| Comment ID | Document | Unique inside `comments.json`; may repeat in another document. |
| Patch ID | Document | Unique inside `patches.json`; lineage resolves in the same store. |
| Patch-group ID | Document | Groups local patches and may repeat across documents. |
| Version/snapshot ID | Document | Resolved through the owning store's manifest and `versions/`. |
| Source import/review batch ID | Document | Groups records inside one document import. |
| Save commit ID and generation | Document | Independent atomic persistence timeline per store. |
| Reply ID | Comment thread | Legacy data reuses reply IDs under different comments; full identity includes `document_id`, parent `comment_id`, and reply ID. |
| Anchor-history ID | Comment | Full identity includes `document_id`, parent `comment_id`, and history ID. |
| Anchor | Owning comment | Anchors have no independent persisted global ID. |

The typed helpers in `lib/project/document-scoped-identity.ts` create composite
references, stable composite keys, scope assertions, and document-bound lookups.
Document-store instances may still use bare IDs internally because `document.json`
ownership is verified before load.

## Audited Cross-Document Boundaries

The repository audit retained bare IDs only in arrays, maps, React keys, and DOM
attributes that render one active document at a time. The unsafe project-level
paths corrected in Phase A.2 were:

- active-comment selection had no explicit document owner;
- `CommentsPanel` reply/edit state could survive a document switch;
- human re-anchor session and confirmation carried only `comment_id`;
- an asynchronous Version History read could open after the active document changed;
- old version entries were briefly retained during a switch;
- focused prompt/import completion could update visible state without checking its original document;
- the assembly planner treated every cross-source local duplicate as global;
- active-comment scroll deduplication used only local comment IDs.

Comments and Version History panels now remount per document. Active selection is
stored under an explicit `document_id`. Re-anchor proposals include `documentId`
and reject a changed owner. Snapshot, prompt, and response-import operations bind
to their starting document and discard or reject stale completion.

## Comments, Patches, Replies, and Anchors

Comments and patches are loaded from one verified document store at a time.
Comment-to-patch, patch-to-comment, reply-to-patch, patch-impact, continuation,
review, accept, reject, anchor recovery, Find, highlight, and rail calculations
receive only the active document's Markdown and records. They never query the
project registry by local review ID.

Reply IDs are thread-local in existing legacy data. For example, the Action Plan
legitimately reuses `PM-THREAD-0001` in several different comments. Reply lookup
therefore includes both the owning document and parent comment.

Human re-anchor candidates are generated only from the owning Markdown. Preview
and confirmation carry the original `document_id`, document hash, UI generation,
and persistence generation. A switch cancels the session; a stale direct callback
is rejected.

## Versions and Recovery

Version IDs and snapshot files are document-local. Version list, compare, view,
restore/recovery validation, content hashes, save generations, and last-known-good
state use the active document's scoped directory handle. Equal version IDs in
different stores are valid. There is no project-wide version timeline or
generation counter.

## Prompt Export and Response Import

Focused-comment export preserves local `comment_id` values. Its structured
project envelope includes project name/ID, document ID, relative file, document
title, and role. Context packs are written to the owning document store.

Protocol v1 ChatGPT responses historically identify comments by local
`comment_id`. The import dialog is an explicit active-document target, so the
importer resolves only against that document's comment array. The persisted
import envelope records `target_document` identity. A missing comment becomes a
local warning; Patchmark never searches another document for a match. Switching
the target before completion rejects the operation.

PDF export retains the Phase A.1 immutable target snapshot of `document_id`,
filename, and Markdown.

## Assembly Classification

Assembly source preflight still rejects duplicate authoritative comment, patch,
or version IDs inside one source document. Across different sources, known
document-owned namespaces are reported as **allowed document-local duplicates**.
Unsafe same-document and project-scoped collisions remain blockers. Unknown
metadata is copied into the verified owning document store and is never promoted
into a project-level registry.

The baseline real Crust Chant audit found six safe duplicate comment IDs and zero
unsafe collisions. The executable audit requires those known six as a subset so
new source comments do not invalidate the architectural check; all current
duplicates are reported. Assembly succeeds, every imported document reopens
through the normal loader, and source fingerprints remain unchanged. The Action Plan contains two
pre-existing orphan patch-to-comment links (`PM-PATCH-0001` →
`PM-COMMENT-0003` and `PM-PATCH-0021` → `PM-COMMENT-0017`). They remain locally
unresolved and are not incorrectly attached to same-ID comments in the research
document.

## Non-Goals

Phase A.2 does not add ID remapping, cross-document threads, cross-document patch
lineage, project-wide comment identity independent of `document_id`, relationship
graphs, coordinated patch acceptance, project-wide context grouping, or imports
into an existing multi-document destination.

# Phase A.3: Document Groups

Document groups add one level of organizational structure to Patchmark's
multi-document project navigator.

> A group is a project-level navigation label. It is not a project, folder,
> document owner, or persistence boundary.

## Why groups exist

A project can contain documents serving distinct logical areas without making
those areas separate projects. For example:

```text
Strategy
├── Shared Research
│   └── Business Dimensions Framework
└── Crust Chant
    ├── Action Plan
    └── Ready-to-Eat Channel Research
```

The project remains the portable persistence root. Markdown documents and their
review stores remain independently owned by stable `document_id` values. Groups
only affect navigation metadata in `.patchmark/project.json`.

Groups are not future workspaces. A future workspace could coordinate multiple
projects, while a group exists inside exactly one project and owns nothing.

## Manifest schema

Projects without groups continue to use and open as schema version 1. The first
group mutation atomically upgrades the project manifest to schema version 2:

```json
{
  "format": "patchmark-project",
  "schema_version": 2,
  "project_id": "prj_strategy",
  "title": "Strategy",
  "manifest_revision": 12,
  "groups": [
    {
      "group_id": "grp_opaque-stable-id",
      "title": "Shared Research",
      "position": 1000,
      "created_at": "2026-07-21T00:00:00.000Z"
    }
  ],
  "documents": [
    {
      "document_id": "doc_framework",
      "path": "business-dimensions.md",
      "display_title": "Business Dimensions Framework",
      "group_id": "grp_opaque-stable-id",
      "role": "research",
      "status": "active",
      "position": 1000,
      "added_at": "2026-07-21T00:00:00.000Z",
      "archived_at": null
    }
  ]
}
```

Schema version 2 always has a `groups` array and an explicit `group_id` on each
document. `group_id` is either `null` or references a group in the same manifest.
Dangling references, duplicate IDs, and normalized case-insensitive duplicate
titles are rejected.

Schema version 1 is read without adding `groups`, adding document membership, or
writing the manifest. Existing flat projects therefore retain their exact
navigator and bytes until a user performs a group mutation.

## Identity and membership

`group_id` is locally generated, opaque, immutable, and independent of title,
path, order, or document identity. Renaming and reordering do not change it.

A document belongs to zero or one group. Groups are flat and cannot contain
other groups. The `Ungrouped` navigator section represents documents whose
`group_id` is `null`; it is not persisted as a synthetic group.

Document-scoped identity remains `(document_id, local_object_id)`. Group
membership is never part of comment, reply, patch, bookmark, version, import, or
export identity.

## Lifecycle and ordering

The navigator supports:

- creating empty groups;
- renaming groups;
- moving groups up or down using sparse positions;
- moving documents between groups and Ungrouped;
- moving documents up or down only within their current group and status;
- removing empty or populated groups after confirmation.

Moving a document to a destination appends it after existing destination
members. Removing a populated group moves active and archived members to
Ungrouped in stable relative order. It never deletes documents or files.

New-document and Add Existing flows expose a group selector when groups exist.
Group membership is included in the same manifest-last registration transaction.
Add Existing never edits the selected Markdown bytes.

## Navigator and collapse state

Projects with no groups use the original flat list without an Ungrouped heading.
Projects with groups show ordered group headings, grouped documents, empty
groups, and an Ungrouped section only when needed. Existing role, bookmark,
archive, restore, missing-file, Locate, rename, and reorder actions remain on the
document rows. Archived rows show their group title.

The editor breadcrumb includes a real group title between project and document.
Ungrouped documents keep the original project/document breadcrumb.

Collapse state is device-local `localStorage` keyed by `project_id + group_id`.
It never changes `manifest_revision`. Renaming preserves it because the key uses
the stable ID. Activating a grouped document automatically expands its group.
When a collapsed group contains bookmarks, its heading exposes compact bookmark
shortcuts so cross-document continuation can reveal the owning document.

## Persistence boundaries

Create, rename, reorder, membership, document reorder, and remove operations use
the existing atomic project-manifest writer and last-known-good recovery file.
They do not write:

- Markdown files;
- document manifests or review stores;
- comments, replies, patches, lineage, anchors, or anchor history;
- bookmarks;
- snapshots, Version History, or persistence generations;
- context packs, imports, exports, or recovery data.

Document creation remains Markdown file, document store, then project manifest
last. Group assignment is part of that final project-manifest transaction.

## Archive, missing files, and bookmarks

Archived and missing documents retain `group_id`. Restore and Locate preserve
membership, order, identity, review state, and bookmarks. Removing a group
ungroups active, archived, and missing members atomically.

Bookmarks remain stored in and owned by document review stores. Group moves,
renames, reordering, and removal do not rewrite or invalidate them. Bookmark
navigation still targets full project/document identity and expands the owning
group locally when required. The anchored removal popover is unchanged.

## Exports, imports, and history

Groups do not broaden operation scope. Prompt exports, PDFs, snapshots, imports,
and Version History remain one-document operations. Response import remains
bound to `document_id`; group titles and membership are non-authoritative display
metadata and are not required by existing formats.

## Compatibility

- Schema-v1 multi-document projects open flat and without writes.
- The first group mutation performs a metadata-only schema-v2 upgrade.
- Legacy single-document opening and in-place conversion remain unchanged.
- Legacy project assembly remains source-immutable and may initially create an
  ungrouped schema-v1 project that can be organized afterward.
- Project manifests use relative paths, so groups remain portable when the
  project root moves.

## Non-goals

Phase A.3 does not add nested groups, nested projects, workspaces, filesystem
folders, shared ownership, tags, group-level comments, patches, bookmarks,
snapshots, Version History, exports, permissions, synchronization, or
collaboration. Moving a document between groups never moves its Markdown file.

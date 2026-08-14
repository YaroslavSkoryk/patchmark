# Patchmark project schema cores

These projects are immutable, deliberately synthetic inputs for production-reader
tests. Tests that write must use `createProjectFixtureCopy` from
`scripts/lib/project-fixture-foundation.mjs`.

- `core-legacy` represents the folder format opened by Patchmark as
  `projectMode: "legacy"`: `document.md` plus a schema-version-1 document store
  in `.patchmark`.
- `core-multidoc` represents a schema-version-2 project registry opened as
  `projectMode: "multi"`, with stable groups, registered documents, and
  schema-version-1 document stores.

The cores contain only required current-store files. Comments and patches are
empty, and focused histories, bookmarks, recovery state, and regression data
belong in later fixtures or deterministic builders.

Phase 2 Comments, persistence, and comment-edit variants are deterministic
overlays in `scripts/lib/fixtures/apply-*-project.mjs`. They reject the committed
source root and may be applied only to a fresh `createProjectFixtureCopy`
result. This keeps the schema cores small and immutable without duplicating
their directory trees.

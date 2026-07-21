# Patchmark

Markdown-first document editor with Visual Mode and Markdown Mode.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the local development server:

```bash
npm run dev
```

Open http://localhost:3000 and load a `.md` or `.markdown` file to begin.

## Working Modes

Patchmark can work in Single File Mode or Project Folder Mode.

### Single File Mode

- Open one `.md` or `.markdown` file.
- Edit the same Markdown source in Visual Mode or Markdown Mode.
- Use `Save Changes` when the browser provides a file handle, or use `Save As` / `Download .md`.

### Project Folder Mode

Project Folder Mode stores clean Markdown documents separately from Patchmark metadata.
Legacy projects continue to use the original single-document layout until a second
document is explicitly created or added:

```text
Project Folder/
  document.md
  .patchmark/
    manifest.json
    comments.json
    patches.json
    tasks.json
    versions/
    context-packs/
    imports/
```

- `document.md` is the Markdown source of truth.
- `.patchmark/comments.json` is reserved for anchored comments and research notes.
- `.patchmark/patches.json` is reserved for pending/accepted/rejected patch suggestions.
- `.patchmark/tasks.json` is reserved for task and context-pack tracking.
- `.patchmark/versions/` stores manual Markdown snapshots.
- `.patchmark/context-packs/` is reserved for exported prompts/tasks.
- `.patchmark/imports/` is reserved for imported responses.

Use `Open Project Folder` to load an existing Patchmark project. Use `Create Project From Current Document` to write the current Markdown as `document.md` into an empty local folder and create the `.patchmark/` structure.

Project Folder Mode also shows Version History from `.patchmark/manifest.json`.
Use `Create Snapshot` to add a Markdown checkpoint under `.patchmark/versions/`.
If the current Markdown is unchanged from the latest snapshot, Patchmark skips creating a duplicate snapshot.
Snapshots can be viewed or compared with the current in-memory Markdown without replacing the live document.
Restore is intentionally not implemented yet.

Project comments are stored in `.patchmark/comments.json`, not in `document.md`.
Right-click in the document to add notes, questions, risks, research needs, and decision points.
The right-side Comments rail displays saved comments beside their approximate anchors.
Comments can apply to selected Markdown text, a whole section, or the whole document.
Comments can be resolved, reopened, edited, or deleted without changing the Markdown document.

Git is optional and can be used manually around the project folder, but Patchmark does not run Git commands yet.

### Multi-Document Projects

After explicit conversion, a project has a versioned document registry and one
independent review store per registered Markdown document:

```text
Project Folder/
  action-plan.md
  ready-to-eat-investigation.md
  .patchmark/
    project.json
    documents/
      doc_.../
        document.json
        manifest.json
        comments.json
        patches.json
        save-commit.json
        versions/
        recovery/
    migrations/
    transactions/
```

- `.patchmark/project.json` is the multi-document commit marker and stores only portable project registry metadata.
- Markdown paths are relative to the project root; outside files, traversal, `.patchmark` paths, and symbolic links are rejected.
- Documents are registered explicitly. Patchmark never scans and auto-registers every Markdown file.
- Each document keeps independent comments, patches, anchors, generations, snapshots, recovery, imports, context packs, and exports.
- `project_id` and `document_id` identify project-level owners. Review-object IDs are local to their owning document, so project-wide identity is `(document_id, local_id)`.
- Display-title and role changes never rename or edit the Markdown file.
- Archive is reversible metadata only; it does not delete Markdown or review history.
- Missing registered files retain their document identity and review store and can be repaired with **Locate file**.
- Active document, editor mode, selection, and scroll restoration are device-local browser state.

See [`docs/phase-a-core-multi-document.md`](docs/phase-a-core-multi-document.md)
for the persistence model, conversion state machine, safety rules, and current
Phase A non-goals.

Phase A.1 also supports **Create Project From Existing Patchmark Projects** for
copying two or more validated legacy projects into a new destination while
preserving independent review stores. See
[`docs/phase-a-1-legacy-project-assembly.md`](docs/phase-a-1-legacy-project-assembly.md)
for source immutability, collision handling, manifest-last assembly, recovery,
and provenance rules.

Phase A.2 preserves duplicate legacy comment, patch, reply, and version IDs when
they belong to different documents. Project-level UI and asynchronous operations
carry `document_id`, while document-bound stores may continue using local IDs.
See [`docs/phase-a-2-document-scoped-identity.md`](docs/phase-a-2-document-scoped-identity.md).

Phase A.3 adds flat, metadata-only document groups to the existing navigator.
Groups never move files or own document review state, and schema-v1 projects
remain flat until the first group mutation. See
[`docs/phase-a-3-document-groups.md`](docs/phase-a-3-document-groups.md).

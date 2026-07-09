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

Project Folder Mode stores the clean document separately from Patchmark metadata:

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
- `.patchmark/comments.json` is reserved for section comments and research notes.
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
Use the Comments panel to add section-level notes, questions, risks, research needs, and decision points.
Comments can be resolved, reopened, edited, or deleted without changing the Markdown document.

Git is optional and can be used manually around the project folder, but Patchmark does not run Git commands yet.

# Human Rewrite Review Workspace

> The human writes the replacement. ChatGPT compares meaning and reports risks. Patchmark applies only the human-authored draft after explicit confirmation.

## Product boundary

Rewrite Workspace is a human-authoring workflow. It is separate from comment re-anchoring, patch rebasing, patch review, Guided Review, and automatic AI rewriting.

- The left pane is a frozen `Current document text` reference.
- The right pane is the editable `My rewrite` Markdown draft.
- ChatGPT is an optional semantic reviewer, not the author or a truth-verification service.
- Importing a review never changes the draft, document, comments, or patches.
- Applying a rewrite never resolves comments or accepts patch proposals.

The MVP supports one active document and one deterministic contiguous selection or complete canonical section. It does not support cross-document, multi-range, or whole-document rewrites.

## Entry and targeting

The shared selection chooser has a separate **Rewrite** group:

- `Rewrite selected text` uses the exact deterministic Markdown offsets already captured by the Visual or Markdown selection system.
- `Rewrite current section` captures the complete containing heading section through the next heading of equal or higher rank.

Unsafe Visual selections do not get an approximate target. The selected-text action is unavailable while the section action can remain available when a canonical containing section exists.

A target records its kind, frozen heading text, heading level and path, base offsets, and bounded surrounding context. Apply canonically re-resolves the target and validates the exact base-text SHA-256. Unrelated edits are allowed after they are saved when the target still resolves unchanged.

## Authoritative project session

> A saved Human Rewrite session is part of the Patchmark project’s document-review data. It remains separate from Markdown until Apply rewrite is confirmed. IndexedDB is used only to recover recent edits that have not yet reached the project store.

Active Rewrite sessions are stored in the owning document’s Patchmark metadata as `.patchmark/rewrite-sessions.json`. In a multi-document project this file lives inside that document’s managed store. Their owner key is:

```text
local project instance + project_id + document_id + rewrite_session_id
```

Only one draft session is active per document. Different documents and local project instances remain isolated even when local comment, patch, or rewrite IDs are duplicated. Opening a complete copied project safely rebinds the local-instance identity without writing back to the source copy.

The schema stores:

- exact local project, project, document, session, and target identity;
- base document generation and SHA-256;
- exact frozen base text and SHA-256;
- exact human draft and SHA-256;
- optional intent note;
- timestamps, stale-reference state, authoritative revision, and project generation;
- prior references after refresh;
- immutable semantic-review request/response rounds.

The human draft starts as a copy of the current text. Draft and intent changes use a debounced, ordered save pipeline: update memory, write a browser recovery copy, atomically commit the project record, and then remove only the matching recovery revision. The UI distinguishes `Saving to project…`, `Saved to project`, `Project save failed — recovery copy saved in this browser`, and `Unsaved changes · Recovery copy unavailable`. It never presents a recovery-only draft as project-saved.

Saving a draft advances the project review-data generation but leaves Markdown, comments, bookmarks, patches, Review Batches, and Markdown Version History unchanged. Close offers `Keep draft and close`, `Discard draft`, and `Cancel`. Keeping flushes the project draft; discarding writes a content-minimized terminal project marker and does not modify Markdown or create Version History. Refresh and project resume derive their reminders from project data and show the document and heading snapshot before resuming.

Applied sessions become content-minimized terminal project records only in the same atomic commit that changes Markdown and creates Version History. Applied and discarded terminal revisions prevent stale browser recovery from resurrecting a finished session.

## Browser recovery and migration

IndexedDB database `patchmark-rewrite-state` is a crash-recovery cache, not authoritative history. A recovery record identifies its owning project, document, session, based-on authoritative revision, recovery revision, synchronization state, and saved timestamp. It temporarily contains the complete unsynchronized session so draft text, intent, and a just-imported review can be retried after a failed project write.

Clearing browser storage does not remove a successfully project-saved draft or semantic-review history. Only edits that never reached `Saved to project` may be absent. If the project is unavailable or read-only, editing can continue in memory and IndexedDB, but the workspace prominently labels the result recovery-only and Apply remains blocked until the authoritative save succeeds.

Legacy sessions from the former IndexedDB-authoritative model migrate when the owning project opens. Patchmark writes and verifies the project record before deleting the legacy browser record. Identical copies are deduplicated. A newer or divergent browser copy is never merged or selected silently: the comparison shows project and browser timestamps, hashes, and readable drafts, then lets the user use the project draft or create a new authoritative revision from the recovery draft.

Every save validates the expected authoritative session revision and current project commit. A stale tab or window fails instead of overwriting a newer project draft; its work remains available as browser recovery for comparison.

## Manual semantic review

`Review meaning with ChatGPT` creates a manual prompt. Patchmark makes no API call and exports no unrelated documents.

Each request is committed to the authoritative project session before the prompt is presented as durably prepared. It records:

```text
rewrite_review_id
rewrite_session_id
project_id
document_id
base_text_sha256
human_draft_sha256
intent_note_sha256
prompt_sha256
exported_at
```

The response protocol is `patchmark.human_rewrite_review_import`, version `1`. Exact import binding requires the session, review, request project, request document, base-text, and draft identities. Duplicate review import is rejected. A valid response is committed to the project session before success is reported; failed project persistence retains it only as explicitly labeled browser recovery for retry.

The structured response covers overall assessment, preserved meaning, changed meaning, omissions, new claims, contradictions, certainty changes, source/citation impacts, ambiguities, and suggested draft edits. Enum and shape validation runs before storage.

When the draft hash still matches, the review is current. A valid response for an earlier exported draft is retained as `Review of an earlier draft` and is not current validation. Editing and exporting another request preserves earlier rounds. One request can await a response at a time; cancelling it allows a new round.

Suggestions can be copied or located in the draft. There is intentionally no `Apply suggestion`, `Accept all`, model-authored replacement, or automatic document patch.

## Impact analysis

Impact preview is read-only and scoped to the active document and target range. It analyzes:

- active selected-text and section comments intersecting the target;
- current anchor transformation and canonical resolution outcomes;
- the active reading bookmark through the same anchor adapter;
- pending patch canonical targets intersecting the target;
- comments included by active exported Review Batches;
- already unresolved active comments;
- document comments, which remain unchanged.

The preview distinguishes likely-safe and likely-unresolved comment outcomes. It does not promise certainty. An exported Review Batch does not block apply or change historical context packs and analyses.

## Stale sessions and refresh

Apply compares the canonically resolved current target hash with `base_text_sha256`.

- A generation increase elsewhere does not block the rewrite.
- A changed target blocks apply with `Refresh current text`.
- Refresh captures a new frozen left reference while preserving the human draft and intent.
- Previous references remain in bounded project session history.
- Existing reviews become historical by hash, and an awaiting old request is cancelled.
- Refresh never merges current text into the human draft.

Empty rewrites are blocked in the MVP. Dirty authoritative editor state and unresolved project/document recovery conflicts also block apply.

## Atomic apply

Apply performs one complete range replacement through the existing document mutation orchestration. Before commit, Patchmark:

1. revalidates project, document, local-instance, session, and target identity;
2. re-runs impact analysis against the current state;
3. prepares a pre-rewrite snapshot without publishing its manifest entry;
4. transforms comments with the shared anchor mutation engine;
5. transforms the bookmark through the same anchor adapter;
6. marks overlapping pending patches stale with `Needs review after human rewrite` metadata;
7. commits Markdown, comments, patches, bookmark manifest, Version History, and an applied terminal rewrite marker together with rollback enabled.

The prepared snapshot becomes a visible Version History entry only in that commit. If the commit fails, the old Markdown, sidecars, and active authoritative rewrite session remain authoritative, no success history entry appears, and the uncommitted snapshot file is removed best-effort. The visible rewrite draft and browser recovery stay available.

The Version History mutation audit records human authorship, rewrite session ID, target kind and heading snapshot, base and applied hashes, and whether a current semantic review existed. It never records the document change as AI-authored or treats model review as proof.

## Comments, bookmarks, patches, and batches

- Safe comment transformations preserve IDs, threads, status, replies, patch relationships, and provenance.
- Unsafe comments remain active and use the existing unresolved-anchor and human re-anchor workflow.
- Document-level and trashed comments remain unchanged; trashed comments are not reactivated.
- Bookmarks retain normal recovery and unavailable-location behavior; no bookmark is created or deleted merely by opening the workspace.
- Overlapping pending patches become read-only stale proposals labeled `Needs review after human rewrite`. Their exact original and suggested text are preserved. They are never rejected or rebased automatically.
- Accepted and rejected patch history remains unchanged.
- Review Batch exports, snapshots, imports, analyses, acknowledgements, and dependency graphs remain historical evidence and are not rewritten or cancelled.

## Accessibility and responsive behavior

The full-screen dialog has labeled read-only and editable panes, visible focus, a focus trap, Escape close behavior, live draft-save status, non-color-only warnings, and focus restoration. Destructive discard requires confirmation.

Desktop uses side-by-side current and draft panes with a separate review area. At 900 px and below, `Current text`, `My rewrite`, and `Review` tabs expose one pane at a time without horizontal page overflow. Reduced-motion preferences disable workspace transitions.

## Portability, privacy, and exports

> Copying the complete Patchmark project includes active Human Rewrite drafts and semantic-review history. Exporting or copying only Markdown does not.

Complete project copies, project assembly, document archive/restore, missing-file recovery, Locate, renamed files, and moved project folders carry the document-scoped rewrite metadata with the same ownership and recovery rules as other document review stores. Assembly remaps project and document ownership while retaining the immutable request identity used to validate already-exported semantic-review responses. A missing Markdown file blocks Apply but does not erase its project-saved draft.

Markdown-only copies and exports omit rewrite sessions. PDF exports also omit them. Deleting the complete project folder or its Patchmark metadata can delete the sessions; clearing browser storage cannot delete project-backed sessions. Browser recovery may temporarily contain recent unsynchronized text. Rewrite data is not claimed to be encrypted and is not written to unrelated logs.

Explicit non-goals include automatic ChatGPT calls, automatic source research, independent factual verification, AI-generated replacement text, automatic suggestion acceptance, patch rebasing, multi-range or cross-document rewrites, and real-time collaboration.

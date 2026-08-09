# Human Rewrite Review Workspace

> The human writes the replacement. ChatGPT compares meaning and reports risks. Patchmark applies only the human-authored draft after explicit confirmation.

## Product boundary

Rewrite Workspace is a human-authoring workflow. It is separate from comment re-anchoring, patch rebasing, patch review, Guided Review, and automatic AI rewriting.

- The left pane is a frozen `Current document text` reference.
- The right pane is the editable `My rewrite` Human Draft.
- ChatGPT is an optional semantic reviewer, not the author or a truth-verification service.
- Importing a review never changes the draft, document, comments, or patches.
- Applying a rewrite never resolves comments or accepts patch proposals.

The MVP supports one active document and one deterministic contiguous selection or complete canonical section. It does not support cross-document, multi-range, or whole-document rewrites.

## Full-screen comparison and editor modes

Rewrite Workspace is a full-screen application surface rather than a centered modal. It occupies the complete viewport, locks scrolling on the document behind it, and uses compact primary navigation for two mounted screens: `Rewrite` and `ChatGPT Review`.

> The Rewrite screen dedicates the viewport to comparing and editing the frozen current text and Human Draft. Semantic-review controls and results live on the separate ChatGPT Review screen.

The Rewrite screen keeps the project/document/target breadcrumb, save state, Close control, shared mode control, pane headers, and compact action bar reachable without scrolling through the draft. Desktop uses an equal 50/50 comparison split based on `minmax(0, 1fr)`. The comparison fills all height left between the compact header and action bar. Each editor owns its vertical scroll; the panes are intentionally not scroll-synchronized, and impact analysis remains a temporary Apply confirmation rather than permanent workspace content.

The ChatGPT Review screen uses one comfortable-width vertically scrolling page for the intent note, prompt export, semantic-response import, current review, historical rounds, findings, and suggested draft edits. Opening it keeps the Rewrite screen mounted but hidden, so the isolated draft editor, current mode, canonical draft, local editor history, and pane scroll positions are not reconstructed. The hidden screen is removed from layout and the accessibility tree through the native `hidden` state.

The shared `View both as` control changes both panes together:

- `Visual` is the documented default. The frozen reference uses the normal Patchmark Visual schema in read-only selection mode, while the Human Draft uses an isolated editable instance with the normal toolbar and local undo/redo.
- `Markdown` shows the exact canonical Markdown in both panes. The reference source is read-only and the Human Draft source is editable.

> Visual and Markdown modes edit the same canonical Human Draft. Switching modes changes its representation, not its ownership or authorship.

> The Current document text pane remains a frozen read-only reference in both modes.

There are no per-mode draft copies and no rewrite-specific Markdown conversion engine. Visual transactions serialize through the same MDX editor and Markdown normalization used by the normal document editor, then update the rewrite session’s single `human_draft` string. Merely switching representation does not advance the draft revision or invalidate semantic review. A real serialized content change does both through the existing draft-hash rules.

The normal Visual schema handles headings, paragraphs, emphasis, links, lists, blockquotes, code blocks, frontmatter, thematic breaks, supported JSX, images, and tables. Rewrite-pane wrappers opt out of the normal reading-width constraint and use all available pane width with `min-width: 0` and `max-width: 100%`. Paragraphs, headings, links, URLs, identifiers, inline code, and code blocks wrap within the assigned pane instead of increasing its min-content width.

Visual tables retain every column, use the pane width with fixed table layout, and wrap cell content vertically. Markdown mode uses soft textarea wrapping plus `pre-wrap`, aggressive overflow wrapping, and hidden horizontal overflow. A long Markdown table row can therefore occupy multiple display lines while remaining one canonical Markdown line.

> Long lines and table content wrap visually within each pane. Display wrapping does not insert line breaks or otherwise change canonical Markdown.

Wrapping is presentation-only: it does not change the Human Draft string or hash, create a project save, invalidate semantic review, alter table pipes or alignment markers, or mutate fenced code content. If the normal Visual editor cannot safely represent Markdown, the raw Markdown remains intact and an explicit Visual-render warning opens the existing Markdown-safe fallback. The Human Draft stays editable as Markdown; unsupported nodes are never silently dropped.

The Visual and Markdown editors are isolated from the authoritative document editor. Draft edits do not dirty or remount the document editor, create document history, transform comments or bookmarks, stale patches, or mutate Review Batches. Those effects remain exclusive to confirmed Apply.

Mode changes return focus to the Human Draft. Markdown cursor selection is restored when deterministic; changing representation can reset the Visual editor’s local undo stack because the current normal editor remounts across mode changes. This limitation is explicit rather than simulated with a second history model.

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

Visual and Markdown edits use that same save pipeline. Close, semantic-review export, impact analysis, and Apply first use the current canonical Human Draft and await its authoritative project save. Semantic review and Apply receive Markdown only—never rendered HTML, Lexical state, or editor-internal JSON. Refresh replaces the frozen base representation while preserving the Human Draft and the currently selected comparison mode.

Saving a draft advances the project review-data generation but leaves Markdown, comments, bookmarks, patches, Review Batches, and Markdown Version History unchanged. Close offers `Keep draft and close`, `Discard draft`, and `Cancel`. Keeping flushes the project draft; discarding writes a content-minimized terminal project marker and does not modify Markdown or create Version History. Refresh and project resume derive their reminders from project data and show the document and heading snapshot before resuming.

Applied sessions become content-minimized terminal project records only in the same atomic commit that changes Markdown and creates Version History. Applied and discarded terminal revisions prevent stale browser recovery from resurrecting a finished session.

## Browser recovery and migration

IndexedDB database `patchmark-rewrite-state` is a crash-recovery cache, not authoritative history. A recovery record identifies its owning project, document, session, based-on authoritative revision, recovery revision, synchronization state, and saved timestamp. It temporarily contains the complete unsynchronized session so draft text, intent, and a just-imported review can be retried after a failed project write.

Clearing browser storage does not remove a successfully project-saved draft or semantic-review history. Only edits that never reached `Saved to project` may be absent. If the project is unavailable or read-only, editing can continue in memory and IndexedDB, but the workspace prominently labels the result recovery-only and Apply remains blocked until the authoritative save succeeds.

Legacy sessions from the former IndexedDB-authoritative model migrate when the owning project opens. Patchmark writes and verifies the project record before deleting the legacy browser record. Identical copies are deduplicated. A newer or divergent browser copy is never merged or selected silently: the comparison shows project and browser timestamps, hashes, and readable drafts, then lets the user use the project draft or create a new authoritative revision from the recovery draft.

Every save validates the expected authoritative session revision and current project commit. A stale tab or window fails instead of overwriting a newer project draft; its work remains available as browser recovery for comparison.

## Manual semantic review

The complete semantic-review workflow lives on the `ChatGPT Review` screen. Its project-backed intent note retains the existing autosave and request-hash semantics. `Generate review prompt` creates the first manual request, `View current prompt` opens an existing exact request without writing project state, `Regenerate review prompt` deliberately supersedes an awaiting request, and `Import semantic review` validates and stores a response. Patchmark makes no API call and exports no unrelated documents. The compact `ChatGPT Review` action on the Rewrite screen only navigates to this screen; it does not bypass the established persistence or protocol path.

> Viewing an exported prompt opens the exact existing request. Regenerating creates a new review request using the current Human Draft, current intent, and latest prompt format.

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
prompt_byte_length
prompt_schema_version
response_schema_fingerprint
prompt_created_at
prompt_generator_version
exported_at
```

The response protocol is `patchmark.human_rewrite_review_import`, version `1`. Exact import binding requires the session, review, request project, request document, base-text, and draft identities. Duplicate review import is rejected. A valid response is committed to the project session before success is reported; failed project persistence retains it only as explicitly labeled browser recovery for retry.

The structured response covers overall assessment, preserved meaning, changed meaning, omissions, new claims, contradictions, certainty changes, source/citation impacts, ambiguities, and suggested draft edits. Enum and shape validation runs before storage.

### Prompt format lifecycle

Prompt format versioning is separate from response protocol versioning. The current prompt format is schema version `2`; the response protocol remains version `1`. A deterministic `sha256:` response-schema fingerprint covers required top-level fields, every required semantic array, object item types, every required item field, empty-field rules, and accepted enums. It does not change for explanatory wording or visual formatting alone. Runtime validation, the exported skeleton, repair examples, in-dialog required-shape examples, and drift tests derive from the same canonical schema description.

> A persisted review request keeps its exact exported prompt. When Patchmark’s response format changes, the old request is preserved but marked outdated. The user generates a new review request with a new identity and the current canonical schema.

ChatGPT Review reports `No review request`, `Awaiting response`, `Prompt format outdated`, `Draft changed since export`, `Intent changed since export`, `Superseded`, `Response imported`, or `Earlier-draft review` as applicable. A request with missing or mismatched prompt-schema metadata is never presented as current-format. Its exact prompt remains available under `View old exported prompt`, while the prominent action becomes `Generate updated review prompt`. A current-format active request always keeps separate `View current prompt` and `Regenerate review prompt` actions.

Regeneration first flushes the current Visual or Markdown draft into canonical Markdown, includes the current intent note, verifies the base and draft hashes, and verifies that the expected old request is still active. A confirmation explains that the awaiting request will be superseded. Cancelling the confirmation performs no write. Confirming prepares one session revision that saves the current draft and intent, marks the old request `superseded`, and appends a new awaiting request. The new round always gets a new `rewrite_review_id`, even when every content hash is unchanged, plus current prompt metadata, an exact UTF-8 byte length, a new exact prompt hash, and a `supersedes_review_request_id` relation.

The old round retains its request ID, exact prompt bytes, prompt hash, hashes, creation time, and a reason such as `prompt_regenerated`, `outdated_prompt_format`, `draft_changed`, or `intent_changed`. `Previous requests` exposes each historical round through `View superseded prompt`; its viewer labels the request as superseded and shows creation time, prompt format, response-schema fingerprint, draft hash, prompt hash, and the reason. `Copy complete prompt` copies only the byte-identical persisted prompt.

> Regeneration never rewrites the old exported prompt. The old request remains available as superseded history.

The candidate is presented only after the authoritative project save succeeds. Prompt-generation persistence uses a recovery fallback containing the current draft and intent but not the uncommitted supersession candidate, so a failed save leaves the old project-backed request active and cannot resurrect a partial new request from IndexedDB. Expected authoritative revision and expected active-request identity reject stale tabs and concurrent generation; the UI also suppresses double clicks. Document ownership is rechecked by the persistence owner, so completion cannot attach to a newly selected document.

If the Human Draft hash changes after export, the active request remains exact and is labeled `Draft changed since export`; `Generate prompt for current draft` creates a new request bound to the current hash. If the intent hash changes, Patchmark labels `Intent changed since export` and offers `Regenerate prompt with current intent`. Neither state silently mutates the exported prompt, and the user may continue waiting for the earlier response.

A structurally valid response for a superseded request first shows an `Import as historical review` confirmation. If confirmed, it is stored only on that exact old round as historical review data; cancelling performs no write. It never becomes the current review and never binds to the newer request. A malformed late response retains all path-level errors and may use structural repair against the old identity.

> Repair preserves the identity of an existing response. Regeneration creates a new review request using the latest prompt format. These are separate operations.

### Canonical semantic-review response

The imported top-level object requires protocol `patchmark.human_rewrite_review_import`, protocol version `1`, the exact session/review/project/document identities, the exact base and Human Draft SHA-256 fingerprints, `overall_assessment`, `summary`, and all nine semantic arrays. `overall_assessment` accepts only `meaning_preserved`, `review_recommended`, `substantial_change`, or `unclear`. The `summary` field is required and may be an empty string.

Every semantic array is required, permits `[]`, and accepts only object items with all documented fields present:

- `meaning_preserved`: `point`, `current_text_evidence`, `rewrite_evidence`;
- `meaning_changed`: `topic`, `current_meaning`, `rewrite_meaning`, `assessment`, `severity`;
- `omitted_points`: `point`, `importance`, `reason`;
- `new_claims`: `claim`, `relative_support`, `note`;
- `contradictions`: `issue`, `severity`;
- `certainty_changes`: `topic`, `from`, `to`, `impact`;
- `source_impacts`: `claim_or_source`, `impact`, `note`;
- `ambiguities`: `issue`, `suggestion`;
- `suggested_draft_edits`: `draft_excerpt`, `suggested_text`, `reason`.

`severity` and `importance` accept only `low`, `medium`, or `high`. `assessment` accepts only `deliberate`, `possibly_unintentional`, or `unclear`. `relative_support` accepts only `present_in_current_text`, `partially_present_in_current_text`, or `not_present_in_current_text`. Source `impact` accepts only `citation_added`, `citation_changed`, `citation_removed`, `source_support_changed`, or `none`. Enum values are case-sensitive.

All item fields are required in protocol version 1; there are no optional semantic item fields. The evidence, current/rewrite meaning, reason, note, impact explanation, and ambiguity suggestion fields may contain an empty string, but their keys may not be omitted. Core finding text, topics, claims, excerpts, suggested text, `from`, and `to` values must be non-empty strings.

> Patchmark accepts only canonical structured semantic-review findings. It may normalize harmless JSON formatting, but it does not invent missing semantic evidence or reasoning.

The exporter generates field instructions and the complete canonical response skeleton from the same schema description used by runtime validation. It lists all nine arrays under an explicit no-string rule, includes a labeled invalid `meaning_preserved` string-array example, and tells ChatGPT that every array item must be an object, primitive array items are forbidden, empty findings use `[]`, every required item field must remain present, all protocol identities and hashes must be copied exactly, and the response must contain one fenced JSON block with no outside prose. A final seven-step self-check covers object-only arrays, required fields, empty arrays, exact enums, exact identities and hashes, one JSON object, and no prose outside the fence.

### Normalization and validation

The importer removes one leading UTF-8 byte-order mark, ignores surrounding whitespace, and accepts either one plain JSON value or one complete fenced `json`/unlabeled JSON block. It rejects multiple JSON blocks and prose outside a fenced block. All semantic arrays are required, so omission is not normalized to `[]`. Enum capitalization is not normalized. Patchmark never converts string findings into objects or fabricates evidence, severity, reasons, source effects, IDs, hashes, or request identity.

Validation issues have stable codes and paths such as `meaning_preserved[0]` with the expected shape, received type, message, and canonical example. Repairable shape errors include invalid JSON/fence structure, primitive array items, missing semantic fields, missing arrays, and invalid enums. Identity, hash, duplicate, cancelled-request, unknown-request, and persistence errors are classified separately and do not offer misleading structural repair.

Import is preflighted as a pure operation before any draft or project save. A malformed response therefore creates no review round, changes no request status, and requests no authoritative write. A valid response is revalidated against the authoritatively saved draft and then committed as one project-backed session revision. Persistence success is never reported before that commit completes; a failed commit leaves the review absent and the response available for retry.

### Import repair workflow

An invalid response keeps the import dialog open and preserves the textarea value exactly, including Unicode and ordering. A focused, screen-reader-announced error panel appears beside the response and Import action, shows the first failing path and required shape immediately, and lets the user expand all remaining issues. The distant workspace error is not the sole explanation.

> When a response has a repairable structural problem, Patchmark preserves the pasted response and generates a repair prompt containing the exact validation errors and required schema.

`Copy repair prompt` copies the complete manual-bridge prompt. It includes exact protocol/version, session/review/project/document identities, base and Human Draft hashes, every validation issue, generated field rules, the complete canonical skeleton, the full untruncated original response, and its UTF-8 byte length and SHA-256. It names the exact request being repaired, forbids replacing its identity with a newer request ID, asks ChatGPT to repair structure without changing review substance, and requires one fenced JSON block without explanatory prose. For an invalid active response, the dialog also offers regeneration and explains the distinction: repair keeps the request identity, while regeneration creates a new request. For a superseded request it explains that the result is historical and that a current-format review requires regeneration in Patchmark. Patchmark never submits the repair automatically.

Wrong identity or hash responses direct the user to select the correct response or export a fresh request. Cancelled and duplicate requests explain their lifecycle state. A response matching an earlier exported round remains importable as `Review of an earlier draft`; current/earlier classification compares the round hashes with the current base and Human Draft hashes after persistence.

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

The full-screen dialog has an accessible title, labeled read-only and editable panes, an announced shared mode state, visible focus, a focus trap, live draft-save status, non-color-only warnings, and focus restoration. The read-only Visual reference blocks editing commands while remaining selectable. Escape closes temporary dialogs first but does not close the workspace or open its close confirmation while the user is editing; workspace exit requires the deliberate Close control. Destructive discard requires confirmation.

Desktop uses side-by-side current and draft panes with no permanent review body below them. At 900 px and below, the primary `Rewrite | ChatGPT Review` navigation remains distinct from the secondary `Current text | My rewrite` navigation inside Rewrite. One comparison pane is exposed at a time, the shared mode control remains available only on Rewrite, the action bar remains fixed, and text, tables, and the Visual toolbar wrap without horizontal page or pane overflow. Reduced-motion preferences disable workspace transitions.

## Portability, privacy, and exports

> Copying the complete Patchmark project includes active Human Rewrite drafts and semantic-review history. Exporting or copying only Markdown does not.

Complete project copies, project assembly, document archive/restore, missing-file recovery, Locate, renamed files, and moved project folders carry the document-scoped rewrite metadata with the same ownership and recovery rules as other document review stores. Assembly remaps project and document ownership while retaining the immutable request identity used to validate already-exported semantic-review responses. A missing Markdown file blocks Apply but does not erase its project-saved draft.

Markdown-only copies and exports omit rewrite sessions. PDF exports also omit them. Deleting the complete project folder or its Patchmark metadata can delete the sessions; clearing browser storage cannot delete project-backed sessions. Browser recovery may temporarily contain recent unsynchronized text. Rewrite data is not claimed to be encrypted and is not written to unrelated logs.

Explicit non-goals include linked pane scrolling, a draggable divider, independent left/right modes, a second Markdown conversion engine, preserving one Visual undo stack across editor remounts, automatic ChatGPT calls, automatic source research, independent factual verification, AI-generated replacement text, automatic suggestion acceptance, patch rebasing, multi-range or cross-document rewrites, and real-time collaboration.

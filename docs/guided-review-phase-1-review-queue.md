# Guided Review Phase 1: Review Queue Foundation

Phase 1 adds a deterministic, document-scoped review queue and a read-only
preview. It answers which comments request another ChatGPT turn, what the next
coherent batch would contain, and why comments were selected or excluded.

> Phase 1 proposes a review batch but does not mark, export, persist, defer, or resolve anything.

## Phase Boundary

Phase 1 includes:

- derived review states for every comment in the active document;
- deterministic follow-up, document-level, and H2-section proposals;
- stable ordering, a five-comment cap, and complete-prompt size estimation;
- structured reason codes and exclusion counts;
- a pure queue API and read-only product preview.

It does not add persistent review batches, batch statuses, automatic focus
marking, prompt export from the preview, persistent deferral, proposal editing,
response-to-batch association, cross-document ranking, or wizard progression.
The existing focused-comment export remains the only export workflow.

## Existing Lifecycle Evidence

The classifier uses current structured Patchmark data rather than display text:

- `comment.status` is human-controlled `open` or `resolved` state.
- `comment.thread` records `user`, `chatgpt`, and `system` entries with durable
  IDs, creation timestamps, optional import IDs, patch lineage, and suggested
  user actions.
- imported clarification questions are ChatGPT thread entries whose
  `suggested_user_action` is `clarify`.
- imported patches carry `comment_id`, `source_import_id`, and `created_at`.
  Accepting or rejecting a patch changes patch state but does not resolve the
  comment or create another conversational turn.
- `comment.export_state` records focus state plus last export/import IDs and
  timestamps. A focus mark alone is not an export or conversational turn.
- an imported response that records `last_import_id` and `last_imported_at` but
  creates no reply, patch, or clarification is treated as structured no-change
  evidence.
- persisted human replies are `user` thread entries. A user entry later than an
  assistant contribution is an explicit request for another turn.
- the current Continue discussion control opens reply UI but does not persist a
  standalone follow-up record. The queue accepts optional document-scoped
  `continue_discussion` or `explicit_assistant_request` evidence for current or
  future callers. A user thread entry with patch lineage is also structured
  follow-up evidence.

Historical export data is reliable only when its IDs, timestamps, and matching
import or later-human evidence form a consistent lifecycle. Incomplete legacy
export history is blocked as `lifecycle_ambiguous` instead of being guessed
ready for re-export.

## Derived States

The classifier applies this precedence:

1. `resolved`
2. `awaiting_chatgpt_response`
3. `blocked`
4. `deferred`
5. `ready_for_chatgpt` or `awaiting_human_review`

The states mean:

- `resolved`: the human resolved the comment.
- `awaiting_chatgpt_response`: reliable structured evidence identifies an
  exported request with no imported response.
- `blocked`: the anchor is unresolved or ambiguous, export lifecycle evidence
  is ambiguous, or the stored comment status is unsupported. Document-level
  comments do not require text anchors.
- `deferred`: the caller supplied the comment ID in a transient deferred set.
- `ready_for_chatgpt`: the latest meaningful turn is a new comment, persisted
  human reply, Continue discussion event, or explicit assistant request.
- `awaiting_human_review`: the latest meaningful contribution is an assistant
  reply, clarification, patch proposal, or explicit no-change import.

State and selection logic use typed reason codes. English explanations live in
the preview component and are not inputs to product decisions.

## Meaningful Turns

`deriveLatestMeaningfulTurn` merges supported comment, thread, patch, import,
and optional follow-up evidence. It orders records by stored timestamps and
uses deterministic source-kind and local-ID fallbacks when timestamps are equal
or absent. It never creates timestamps, scans prose for intent, or treats a
focus mark or patch decision as a conversational turn.

Explicit follow-ups are surfaced separately because they receive first
priority. If several are eligible, the earliest requested follow-up is proposed
alone. Stable document and ID ordering breaks ties.

## Deterministic Proposal

The engine receives one explicit `projectId + documentId` and only that
document's already loaded Markdown, comments, and patches.

1. Classify and canonically resolve every supplied comment.
2. If an explicit follow-up is ready, propose the earliest one alone.
3. Otherwise select the earliest ready comment in document order.
4. If it is document-level, propose it alone.
5. Otherwise add later ready comments from the same nearest H2 bucket.
6. Stop at an H2 boundary, five comments, or the configured complete-prompt
   estimate of approximately 20,000 tokens.

Comment order is resolved document position, creation time, then `comment_id`.
Document-level comments have document position zero, preserving their existing
whole-document ordering semantics. H3 and lower comments stay under their
nearest H2. Comments before the first H2 use the stable
`document:introduction` bucket. Group membership does not affect priority.

If the first eligible comment alone exceeds the prompt limit, it is still
proposed with a structured warning.

## Prompt Estimation

The editor now exposes a pure `buildFocusedCommentsPromptPreview` boundary
around the existing focused-comment payload and prompt builders. Queue
estimation passes the proposed comments through that same construction path,
including collaboration rules, document identity and context, anchors,
conversation history, patch lineage, table context, and JSON envelope.

Dry runs use fixed placeholder export metadata with the same shape as a normal
export. They do not call `writeProjectContextPack`, update focus/export fields,
save comments, or alter generations. The local deterministic estimate is
`ceil(UTF-8 bytes / 3)` and is intentionally labeled approximate rather than an
exact tokenizer count.

## Output Contract

`deriveReviewQueue` returns:

- algorithm version, project ID, document ID, and document generation;
- counts for all six states;
- ordered comment classifications with anchor availability, latest meaningful
  turn, section bucket, batch priority, and structured reason code;
- a proposal or `null`;
- proposal type, selected IDs, section, approximate complete-prompt tokens,
  warning, structured selection reasons, and stop reason;
- structured exclusion counts for later sections, unselected ready comments,
  human/assistant waits, blocked anchors, ambiguous lifecycle, deferred, and
  resolved comments.

Identical inputs produce identical semantic output. The result contains no
runtime timestamp or random ID.

## Original Preview and No-Write Guarantee

Phase 1 originally exposed **Guided Review Preview** in Project Folder Mode.
Phase 3 replaces that diagnostic modal with the Guided Review Wizard while
retaining the same no-write guarantees for overview and transient proposal
interactions. Computation starts
only when the preview is opened and recomputes from the current active working
Markdown while open. The modal displays queue counts, the proposed batch,
approximate prompt size, selection reasons, selected comment details, and all
classifications.

The preview offers only **Close**. It cannot mark, export, copy, save, defer,
remove, create a batch, or mutate a comment. Browser coverage fingerprints the
full project and inspects the File System Access write log across repeated
open/close and document switching. Markdown, manifests, document stores,
comments, patches, bookmarks, versions, recovery, and context packs remain
unchanged.

## Multi-Document, Recovery, and Switching

Queue identity is `project_id + document_id`; local comment identity remains
`document_id + comment_id`. Duplicate local comment IDs in different documents
cannot collide because the engine never scans other document stores.

The current in-memory Markdown is authoritative for anchor positions, section
buckets, order, and prompt content, including recovered unsaved Markdown. Queue
evaluation never saves that content. Bookmarks do not affect priority.

Loading a standalone file or another project document closes the wizard. Queue
construction is synchronous and tied to the current render's document identity,
so a previous document's proposal cannot complete later beneath a new title.
Closed previews perform no queue or prompt-size work, preserving the existing
document-switch loading boundary.

## Phase 2 Limitations

Phase 1 does not persist the proposed batch or a dedicated Continue discussion
event. Existing reliable per-comment export state can identify an outstanding
request, while ambiguous legacy histories fail safe. A later phase can add
document-scoped batch records, durable progression, response association, and
dedicated follow-up events without changing the pure classifier contract.

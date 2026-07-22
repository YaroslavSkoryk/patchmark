# Guided Review Phase 2: Persistent Review Batches

Phase 2 gives every newly tracked focused-comment prompt durable,
document-scoped ownership. A Review Batch owns one exact exported prompt for one
document. It does not resolve comments or approve document changes.

## Phase Boundary

Phase 1 remains the deterministic, read-only queue and proposal engine. Opening
or closing its preview performs no authoritative writes. Phase 2 begins only
when the user explicitly generates a tracked prompt from that proposal or from
the existing manual focused-comment selection.

Phase 2 does not add proposal editing, deferral, response completeness,
acknowledgment, automatic progression, cross-document batching, automatic patch
acceptance, or automatic comment resolution.

## Document-Scoped Storage

Review Batch history is stored in the owning document store at
`.patchmark/review-batches.json`. In a multi-document project, this resolves
inside `.patchmark/documents/<document_id>/`; legacy single-document projects
continue through their established document-store boundary.

The optional `review_batches` descriptor is part of the document save commit.
Once introduced, it participates in the same generation ordering, SHA-256
validation, last-known-good recovery, no-op suppression, and corruption checks
as Markdown, comments, patches, and the document manifest. Older four-file save
commits remain valid and do not create a batch file merely by opening a project.

Authoritative ownership is always:

```text
project_id + document_id + batch_id
```

Local comment IDs are interpreted only inside the batch's document. Group,
display-title, and relative-path changes do not affect ownership.

## Schema

Schema version 1 preserves:

- immutable batch, project, and document IDs;
- source: `guided_review` or `manual`;
- type: `follow_up`, `document_level`, `section`, or `manual`;
- exact ordered comment IDs and per-comment SHA-256 fingerprints;
- source document generation and Markdown SHA-256;
- Guided Review algorithm version when applicable;
- prompt-builder version, prompt SHA-256, estimated tokens, and oversize warning;
- context-pack relative path, SHA-256, and byte count;
- document title and optional section snapshots;
- status, lifecycle timestamps, cancellation reason, and import ID.

The valid status lifecycle is:

```text
exported -> response_received
exported -> cancelled
```

Only `exported` is active. Cancelled and response-received records remain as
history.

## One Active Batch

A document may have at most one `exported` Review Batch. The repository enforces
this inside the existing per-document atomic write queue, so repeated or
concurrent manual and Guided Review export attempts cannot commit two active
batches. Different documents can each own an active batch, including documents
whose comments use identical local IDs.

When a document already has an active batch, manual export and Guided Review
show that batch instead of replacing it. The user can copy or open its exact
prompt, import a response, or cancel it.

## Export Transaction

Tracked export follows this order:

1. Revalidate the target document, current generation, selected open comments,
   canonical anchors, and Guided Review proposal.
2. Generate a new opaque batch ID.
3. Build the existing focused-comment prompt with a structured batch envelope.
4. Compute document, comment, and exact prompt fingerprints.
5. Write the context pack and read it back to verify exact bytes and SHA-256.
6. Atomically commit the Review Batch record last.
7. Derive active-export evidence from the committed record.

The batch record therefore never commits before its context pack is available.
If the context-pack write fails, no batch exists. If batch persistence fails,
the uncommitted context pack is removed where supported and is never inferred as
active. A retry compares against authoritative committed state, including when
a prior save-marker installation failed.

## Exact Prompt Ownership

Every tracked prompt contains this additive envelope:

```json
{
  "review_batch_id": "review_batch_...",
  "project_id": "prj_...",
  "document_id": "doc_...",
  "ordered_comment_ids": ["PM-COMMENT-0001"]
}
```

The response instructions require ChatGPT to return the exact batch, project,
document, and comment identities. The context pack contains the complete prompt
that was fingerprinted by the batch record.

Copying or opening a batch always reads the committed context pack and verifies
its byte count and SHA-256. It never regenerates from current Markdown or current
comments. Document edits, comment replies, resolution, re-anchoring, rename,
regroup, archive, and Locate operations leave the historical prompt unchanged.

## Manual and Guided Export

Guided Review rederives and compares the current Phase 1 proposal immediately
before export. A changed generation, changed proposal, missing comment, closed
comment, unusable anchor, or concurrent active batch blocks stale export.
Oversized first-comment warnings are retained in batch metadata.

Manual export uses the existing focused-comment order, may cross sections, and
creates `source: manual` with `batch_type: manual`. Existing focus marks remain
unchanged; Review Batches do not turn focus state into queue state.

## Queue Evidence

The active batch supplies document-scoped active-export evidence to Phase 1 for
each ordered comment ID. Those comments derive as Awaiting ChatGPT response and
are not proposed again. Patchmark does not write that state into every comment.

Cancellation or exact response receipt removes the active evidence. Phase 1 then
reclassifies comments from their actual open/resolved state, conversation,
clarification, and patch history.

## Cancellation

Cancellation validates the owning document and active batch, then atomically
records `cancelled`, `cancelled_at`, and a structured reason. It keeps the exact
context pack and all batch history.

Cancellation never deletes or changes Markdown, comments, replies, patches,
imports, bookmarks, versions, recovery data, or focus marks. A failed
cancellation leaves the previous committed `exported` state authoritative.

## Response Receipt

The legacy response importer remains available. Newly tracked responses may add
top-level `review_batch_id`, `project_id`, and `document_id` fields to protocol
version 1.

When all three values exactly match the active batch and target document,
Patchmark first performs the normal comment and patch import. Only after that
commit succeeds does it atomically mark the batch `response_received` and store
the import ID and timestamp.

Missing, incomplete, unknown, cancelled, completed, or mismatched identity does
not complete an active batch. A valid legacy response still imports normally,
but Patchmark warns that exact association was unavailable. Comment-ID overlap
alone is never used for batch association.

## Recovery, Resume, and Switching

Batch state is authoritative project metadata, not browser recovery data.
Project resume and document switching load only the target document's batch
metadata; context-pack bodies load only when opened or copied. Stale async UI
completion is checked against the active document before it updates the editor,
while persistence remains bound to the originally captured project document.

Last-known-good recovery validates the optional batch descriptor and restores or
removes the batch file consistently with the selected committed generation.
Legacy context packs and comment export-state fields remain historical artifacts
and are not inferred as active Review Batches.

## Future Handoff

Phase 3 adds proposal adjustment and the Guided Review wizard while preserving
this transaction. Phase 4 may add response completeness, partial-response analysis, summaries,
acknowledgment, and next-batch progression. Those phases must continue using the
exact document-scoped ownership and committed-prompt guarantees established
here.

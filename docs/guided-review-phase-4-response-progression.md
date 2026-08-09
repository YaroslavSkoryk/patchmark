# Guided Review Phase 4: Response Analysis and Progression

Phase 4 closes the local Guided Review loop after an exact tracked response is
imported. It analyzes structured imported records, persists an immutable
summary, presents that summary in Guided Review, and requires explicit human
acknowledgment before another Review Batch can be exported.

## Phase Boundary

Phase 4 does not resolve comments, accept or reject patches, accept dependency
prerequisites, edit Markdown, generate follow-up content, or send data to
ChatGPT.

> Acknowledging a response advances Guided Review only. It does not resolve
> comments, approve replies, accept patches, or imply agreement with ChatGPT.

## Exact Identity

Every response analysis is owned by the exact tuple:

```text
project_id + document_id + review_batch_id + import_id
```

The Review Batch's `ordered_comment_ids` define the expected response scope.
An exact response containing a reply, patch, or clarification for a comment
outside that scope is rejected before authoritative mutation. Exact responses
for already responded or acknowledged batches are also rejected.

Legacy imports without Review Batch identity retain their untracked
compatibility path and do not create a Phase 4 summary.

## Persisted Analysis

The document-scoped `review-batches.json` record stores `response_analysis`
with schema version 1:

- exact project, document, batch, and import identities;
- `complete` or `partial` coverage;
- immutable analysis timestamp;
- outcomes in original batch order;
- exact imported reply, patch, clarification, and explicit no-change IDs;
- per-comment counts and addressed state;
- aggregate expected, addressed, unanswered, reply, patch, clarification, and
  explicit no-change counts.

The schema validator checks identity, batch order, unique contribution IDs,
derived counts, aggregate totals, and coverage consistency.

Analysis includes only records carrying the exact `source_import_id`. Old
assistant replies, old patches, later human replies, later patch decisions,
and records from another document never contribute to the snapshot.

Patchmark's current import protocol has no structured explicit no-change item.
Phase 4 therefore leaves `explicit_no_change_ids` empty and does not infer
no-change responses from prose.

## Addressed Comments

A batch comment is addressed when the exact import commits at least one:

- assistant reply;
- patch proposal;
- structured clarification question;
- structured explicit no-change response, if a future compatible protocol adds
  one.

Multiple contributions still count as one addressed comment. Clarification
thread entries are counted separately from ordinary replies. Dependency-aware
patches are all counted, regardless of their pending or blocked review state.

No imported contribution means the comment is unanswered for that historical
response. Patchmark does not infer rejection, intent, or quality.

## Batch Lifecycle

The lifecycle is:

```text
exported
→ responded | responded_partial
→ acknowledged
```

`cancelled` remains terminal for cancelled exports. Existing
`response_received` records remain readable as a legacy compatibility state.

- `exported` is the only active response-waiting status.
- `responded` stores complete exact coverage awaiting acknowledgment.
- `responded_partial` stores partial exact coverage awaiting acknowledgment.
- `acknowledged` preserves the historical analysis and records
  `acknowledged_at`.
- `response_received` stores a legacy minimal receipt.

Tracked manual batches use the same lifecycle and preserve their original
cross-section comment order.

## Atomic Import

Exact response import performs:

```text
parse and validate
→ validate exact batch scope
→ validate and simulate dependencies
→ construct imported records
→ derive exact analysis
→ commit comments, patches, analysis, and batch status together
```

The raw import wrapper is written before the authoritative project transaction
and removed if that transaction fails. A failed dependency check, response
analysis, or project commit leaves the batch exported and creates no response
summary. Retrying a repaired response remains safe.

## Response Summary

Guided Review prioritizes:

1. an active exported batch;
2. an unacknowledged complete or partial response;
3. a legacy minimal response receipt;
4. the normal queue.

The summary reads persisted analysis directly. It shows complete or partial
coverage, aggregate counts, and outcomes in original batch order. Per-comment
actions use the existing document-scoped comment navigation.

Closing Guided Review does not acknowledge the response. Restarting or
switching away preserves the summary for its owning document.

Legacy `response_received` records are upgraded only on explicit Guided Review
access when exact `source_import_id` provenance is available. If provenance is
insufficient, Patchmark displays that detailed coverage is unavailable and
does not reconstruct counts from full comment history.

## Acknowledgment and Queue Progression

`Continue to next batch` atomically changes only the Review Batch status and
`acknowledged_at`. It preserves analysis and does not write Markdown, modify
comments, decide patches, clear focus, or send a prompt.

After acknowledgment, the normal deterministic queue is recalculated from
current authoritative state:

- addressed open comments with assistant contributions normally await human
  review;
- unanswered comments retain their latest meaningful human turn and normally
  become Ready for ChatGPT;
- newer human follow-ups, resolution, deferment, blocked anchors, and another
  active batch take precedence;
- unresolved answered comments do not block a new batch containing other Ready
  comments.

Partial responses do not create a special queue or force an unanswered-only
batch. Existing follow-up, document-level, section, ordering, and prompt-size
rules remain authoritative.

## Isolation, Recovery, and Performance

Analysis remains document-owned even when local comment, patch, reply, or
import IDs are duplicated in another document. Group moves, display-title
changes, Locate operations, bookmarks, and Markdown recovery do not change
analysis ownership or counts.

Response analysis participates in the existing document save transaction and
LKG recovery. Browser Markdown recovery cannot create or acknowledge response
analysis.

New summaries load the persisted snapshot without rescanning historical
threads, patches, imports, other documents, or Version History bodies.

## Explicit Non-Goals

Phase 4 does not implement automatic resolution, patch decisions, dependency
acceptance, follow-up generation, ChatGPT sending or retrieval, semantic
grading, cross-document batches, project-wide progression, or batch rollback.

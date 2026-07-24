# Coordinated Patch Dependencies

Patchmark response protocol version 2 represents explicit dependencies between
patch proposals from one response. This solves cases where one narrow patch
supplies document context required by another, such as a section-level source
date disclosure followed by several inline-link patches.

> A dependency allows one patch to rely on another patch’s accepted document
> change. It never causes either patch to be accepted automatically.

## Response schema

Protocol-v2 responses keep the existing
`patchmark.comment_reply_import` shape. Every patch proposal also requires:

```json
{
  "patch_key": "horme-inline-links",
  "depends_on": ["competitor-observation-dates"],
  "comment_id": "PM-COMMENT-0019"
}
```

- `patch_key` is a non-empty, response-local, opaque identifier.
- `depends_on` contains patch keys from the same response.
- Independent proposals use an empty `depends_on` array.
- Display titles and response array indexes are never dependency identities.
- Protocol-v1 responses remain supported and all their patches remain
  independent.

## Scope and graph validation

Dependencies are limited to the same response, project, document, and comment.
Patchmark rejects the complete import before authoritative writes for duplicate
keys, missing references, duplicate dependency entries, self-dependencies,
cycles, cross-comment relationships, unsupported field shapes, and response
document identity mismatches.

Transitive prerequisite order is deterministic. Response order is the primary
tie-breaker and `patch_key` is the secondary tie-breaker.

## Combined-state simulation

Before importing any reply or patch, Patchmark creates an in-memory simulation
for every proposal:

1. Start from the current document.
2. Apply the proposal’s transitive prerequisites in deterministic order.
3. Apply the proposal.
4. Validate the resulting document.

Simulation uses the existing canonical pending-patch target resolver and shared
text replacement operation. It writes no files, creates no snapshots, advances
no save generation, changes no comments, and records no Review Batch receipt.
Missing, ambiguous, stale, or overlapping targets fail with structured
dependency error codes.

## Source validation

A dependent source-link patch can rely on a declared prerequisite disclosure
when the prerequisite remains visible in the same target section or a
deterministically containing section. Coverage must contain the required
publication statement and the exact observation date. Patchmark does not search
undeclared siblings or unrelated sections.

Visible publication-unavailable wording is matched deterministically across
singular and plural forms, including `publication dates unavailable` and
`no available publication date`. A shared annotation may follow multiple links
in the same prose block; validation uses that containing block rather than a
fixed character window. Table-link annotations remain row-scoped.

When a dependent patch deletes a Sources, Source Notes, or References section,
the simulated final document must retain every visible source URL from the
deleted text. Markdown-escaped ampersands in a visible URL compare as the same
URL as the unescaped inline link. Omitting a required inline-source prerequisite
fails the import.

This first implementation validates visible URLs. It does not infer source
equivalence from titles or prose.

## Persistence and review

Imported patches preserve:

- `source_patch_key`;
- resolved `depends_on_patch_ids`;
- `depends_on_patch_keys_snapshot`.

Runtime acceptance uses internal document-local patch IDs and verifies matching
import, comment, and key provenance. Existing patches without dependency
metadata remain independent and are not rewritten.

The review dialog shows direct prerequisite links plus transitive accepted,
pending, rejected, and unavailable counts. A dependent patch remains fully
inspectable and rejectable while blocked. Its Accept action is disabled for:

- pending prerequisites;
- rejected prerequisites;
- missing, stale, or invalidly owned prerequisites;
- a current document that no longer matches the dependency-validated state.

Accepting a prerequisite applies only that patch. Once every transitive
prerequisite is accepted, Patchmark reuses normal current-document target
validation before enabling and applying the dependent patch. Existing snapshot,
Version History, anchor recovery, comment lineage, and open-comment behavior
remain unchanged.

## Guided Review and repair

New focused-comment and Guided Review prompts request protocol version 2,
`patch_key`, and `depends_on`. Dependency-aware repair text identifies graph or
combined-state failures and preserves Review Batch identity, comment IDs, patch
content, sources, reasons, and risks.

Source-date dependency failures use
`dependency_source_date_coverage_failed` and report the failing `patch_key`,
source URL, expected observation date, and whether the disclosure prerequisite
was absent, unrelated, or invalid. Missing disclosure dependencies ask for a
`depends_on` graph correction rather than duplicated row-level disclosure.

Graph and simulation validation happen before the existing import write path.
The Review Batch response receipt is still recorded only after replies, patches,
and dependency metadata commit successfully. A failed validation leaves the
batch exported and creates no partial dependency graph.

## Production regression

The production failure fixed in July 2026 used the byte-faithful fixture
`scripts/fixtures/protocol-v2-dependency-import-response.json`. Its 18-patch
graph was valid, but import failed before dependency simulation because an
independent four-link paragraph placed its shared
`publication dates unavailable; prices observed 16 July 2026` annotation more
than 220 characters after the first link. After that mismatch was corrected,
Sources deletion exposed a second comparison defect: a visible source URL used
a Markdown-escaped `\&`, while its preserved inline link used `&`.

Regression coverage now runs the exact response through parsing, deterministic
dependency ordering, combined-state simulation, source preservation, import
commit, and Review Batch receipt. The production browser test runs against a
caller-provided Patchmark URL and verifies that a missing dependency performs no
writes, while the exact response stores all patches as pending and records the
response receipt only after the patch commit.

## Non-goals

This phase does not infer dependencies, allow cross-comment or cross-document
graphs, link separate imports or Review Batches, accept prerequisite sets,
perform graph-wide rollback, call a model for repair, or implement Guided Review
Phase 4 response progression.

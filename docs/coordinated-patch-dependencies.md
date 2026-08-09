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

> Response order does not create a patch dependency. Only `depends_on` does.

## Combined-state simulation

Before importing any reply or patch, Patchmark creates an in-memory simulation
for every proposal. An exact Review Batch response starts from the immutable
Markdown snapshot exported with that batch; an untracked legacy response starts
from the current document:

1. Start from the exact current/base document state for that proposal.
2. Apply only the proposal’s declared transitive prerequisites in deterministic
   order.
3. Apply the proposal.
4. Validate the resulting document.

Every independent proposal receives an isolated copy of the base Markdown and
never sees an unrelated imported sibling. Every dependent proposal receives a
dependency-specific state containing only its transitive prerequisite closure.
Before simulation, Patchmark preflights complete patch targets against that
base Markdown. A uniquely resolved base target receives canonical provenance;
a target absent from the base remains eligible for dependency-created target
resolution after its prerequisites run.

Simulation uses the existing canonical pending-patch target resolver and shared
text replacement operation. It writes no files, creates no snapshots, advances
no save generation, changes no comments, and records no Review Batch receipt.
Missing, ambiguous, stale, or overlapping targets fail with structured
dependency error codes.

The prompt context pack is never a target corpus. Full-document, section, table,
display-target, and anchor excerpts may repeat inside that human-readable file,
but import resolution searches only one authoritative Markdown snapshot.

Canonical candidates are identified by their physical content range in that
snapshot. Range boundaries that differ only by leading or trailing whitespace
collapse to the same identity, while discovery methods remain as provenance in
`supportingMethods`. A linked comment anchor, target-heading match, and
normalized-text match can therefore describe one target without creating false
ambiguity. Two distinct physical ranges remain ambiguous.

Owning comments provide deterministic scope only when their canonical anchor
resolves uniquely and the patch target is proven inside that scope. Duplicate
heading sections, document-level anchors, and unrelated anchors do not justify
choosing the first occurrence.

## Canonical base-target provenance

Base-origin targets persist document identity, the exported base SHA-256,
canonical base and current Markdown offsets, a complete-original-text
fingerprint, the response-local patch key, declared target heading, full owning
heading ancestry, and the unique base occurrence count. Browser DOM positions
and occurrence indexes are not target identity.

For every prerequisite replacement, Patchmark transforms each pending mapped
range:

- a replacement before the target shifts both offsets by its length delta;
- a replacement after the target leaves the range unchanged;
- an insertion that copies identical text elsewhere leaves the original mapped
  range intact;
- an overlapping replacement marks the mapping for revalidation instead of
  trusting stale offsets.

After prerequisite simulation, the mapped range must still contain the full
exact `original_text`, belong to the same document, and retain compatible owning
heading ancestry. The deterministic resolution priority is:

1. valid transformed base-target provenance;
2. a unique full-text match under the persisted heading ancestry;
3. the existing declared-heading and document-wide canonical resolver for a
   target that did not exist in the base;
4. failure.

Short linked-comment anchors never override a valid full-patch provenance
target. Heading text alone never selects the first of multiple identical
sections.

> When a patch target is unique in the exported base document, Patchmark
> preserves that target’s canonical identity through declared prerequisite
> mutations. A prerequisite that copies identical text elsewhere does not make
> the original target ambiguous.

> Patchmark still rejects targets that were ambiguous in the base snapshot or
> whose identity cannot be validated after prerequisite changes.

A dependency-created target has no base provenance. Patchmark applies only its
declared prerequisite closure, then requires the existing canonical resolver to
find one valid target in that resulting Markdown. Two created copies remain a
genuine ambiguity.

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
- `depends_on_patch_keys_snapshot`;
- optional document-scoped `target_provenance` for uniquely resolved base
  targets.

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

Accepting a prerequisite applies only that patch and transforms the provenance
of other pending patches through the exact accepted replacement. Bounded manual
edits transform ranges through their Markdown change sets; broad or overlapping
edits require heading-ancestry revalidation. Once every transitive prerequisite
is accepted, the same provenance-first resolver validates the current document
before enabling and applying the dependent patch. If the original target was
deleted or rewritten, Patchmark marks it unavailable rather than attaching the
patch to a copied occurrence. Existing snapshot, Version History, anchor
recovery, comment lineage, and open-comment behavior remain unchanged.

## Guided Review and repair

New focused-comment and Guided Review prompts request protocol version 2,
`patch_key`, and `depends_on`. They also ask the model to simulate coordinated
patches in dependency order and retain an owning parent heading when one patch
copies a structural region that a dependent patch later edits. Dependency-aware
repair text identifies graph or combined-state failures and preserves Review
Batch identity, comment IDs, patch content, sources, reasons, and risks.

Target failures distinguish genuine ambiguity in the exported snapshot, a
target changed by declared prerequisites, later current-document staleness, and
an internal independent-simulation invariant. Current-document and internal
invariant failures do not show a misleading ChatGPT repair prompt because
rewriting a valid response cannot repair local document state or Patchmark
behavior. Genuine exported-snapshot ambiguity still produces focused repair
guidance.

`dependency_target_genuine_ambiguity` reports the dependent and prerequisite
keys, target heading, base and post-prerequisite match counts, whether the base
target was unique, and the exact ambiguity reason. Its repair prompt asks for a
unique owning parent scope or one atomic structural proposal. It does not route
the failure through unrelated source-date or Sources-section instructions. A
dependency-induced copy resolved by base provenance produces no error or repair
prompt.

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

A second byte-locked regression fixture,
`scripts/fixtures/independent-protocol-v2-import-response.json`, contains four
independent proposals for sections 9.1–9.3, including the complete long
unit-economics replacement. Its exact payload is 11,573 bytes with SHA-256
`08b1eba33fae1244d101c6d4d3b2a1fe4b1df7d77a43847a448d8ba56e0d3ffa`.
Direct tests record the empty closure and unique canonical range for every
proposal. Production-browser coverage verifies the atomic four-reply/four-patch
import, Review Batch response analysis, no dependency badges, no automatic
acceptance, and continued reviewability of later independent patches after one
earlier sibling is accepted. A saved-document divergence variant verifies that
import still validates against the persisted exported snapshot while later
acceptance revalidates against the changed current document.

The real July 2026 Review Batch
`review_batch_8db57c18-bfa8-4abd-b4ae-2651f4d45b95` exposed a false target
ambiguity for `explain-unit-economics-formulas`. Its exported Markdown contained
one `### 9.2 Reusable formulas` section. Exact matching returned
`50823:51698`; normalized matching removed the proposal's two trailing newlines
and returned `50823:51696`. Patchmark previously treated those whitespace-only
boundary differences as distinct candidates. Physical-range canonicalization
now merges them while retaining linked-anchor, target-heading, and normalized
provenance. Regression coverage keeps genuine duplicate sections blocked.

The long-table target-duplication regression fixture
`scripts/fixtures/dependency-induced-target-duplication.json` preserves the
reported Review Batch, project, document, comment, patch keys, dependency graph,
and complete Scenario indicators table. Its base target occurs once and occurs
twice globally after the appendix prerequisite. Direct coverage verifies import
simulation, persisted provenance, copy-twice behavior, before/after offset
transforms, dependency-created targets, genuine base and created-target
ambiguity, document isolation, relevant repair text, and acceptance of the main
section without changing the appendix copy.

## Non-goals

This phase does not infer dependencies, allow cross-comment or cross-document
graphs, link separate imports or Review Batches, accept prerequisite sets,
perform graph-wide rollback, call a model for repair, or implement Guided Review
Phase 4 response progression.

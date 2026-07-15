# Patchmark Phase 7A Persistence Audit

Audit date: 2026-07-15  
Git root: `/Users/yskoryk/Documents/patchmark`  
Branch: `develop`

This was an audit-only phase. The live Patchmark project was never opened through a writable audit fixture, compacted, normalized, or rewritten. Browser diagnostics used an in-memory file server backed by a byte-for-byte copied fixture.

## 1. Repository and fixture identity

- Live source project: `/Users/yskoryk/Documents/patchmark_docs/action_plan_market_growthb`
- Copied audit fixture: `/private/tmp/patchmark-phase7a-fixture`
- The project path was verified by scanning candidate Patchmark projects and identifying the one with the approximately 70 MB `comments.json`; it was not assumed from its name.
- The live and copied fixture inventories contained 74 files and were byte-identical before and after the audit.
- The copied fixture and disposable production build were removed after final validation. The paths above identify the artifacts used during the audit.

Key SHA-1 hashes were identical in live and copied data:

| File | SHA-1 |
|---|---|
| `document.md` | `418e827b959eb1f7337660c37934c508aaaaf68d` |
| `.patchmark/comments.json` | `052d52020d635af1f4e7729256945abc7542c6e4` |
| `.patchmark/patches.json` | `4759aa902b78df583c5973e5b826402e099782b1` |
| `.patchmark/manifest.json` | `13b93970d7dbece9dfc8ca2e9d1e3ced83908083` |

The comments SHA-256 was `ac176df9e676c60da530d785e32a512d8e52bafd2a5afbad49c2f1adf1340bb7` in both copies.

## 2. Exact project file sizes

Total project size was 76,609,351 raw bytes across 74 files.

| File/category | Files | Raw bytes | Compact JSON bytes | Gzip bytes | Objects | Average object bytes | Maximum object bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| `.patchmark/comments.json` | 1 | 73,421,300 | 68,331,873 | 6,871,051 | 31 | 2,204,252.94 | 18,950,292 |
| `.patchmark/patches.json` | 1 | 222,579 | 208,408 | 29,519 | 59 | 3,531.32 | 29,379 |
| `.patchmark/manifest.json` | 1 | 15,932 | 13,449 | 3,493 | 1 | 13,449 | 13,449 |
| `.patchmark/tasks.json` | 1 | 3 | 2 | 23 | 0 | 0 | 0 |
| `document.md` | 1 | 67,402 | n/a | 15,702 | n/a | n/a | n/a |
| `.patchmark/versions/` | 49 | 2,740,310 | n/a | 679,662 | 49 files | 55,924.69 | 67,463 |
| `.patchmark/imports/` | 20 | 141,825 | n/a | 40,141 | 20 files | 7,091.25 | 20,738 |

Snapshot sizes ranged from 44,207 to 67,463 bytes. Import files ranged from 2,452 to 20,738 bytes. No unexpected backup, temporary, cache, or hidden persistence file was found.

`document.md` was 67,402 bytes and 293 lines. The small difference from earlier character estimates is normal byte-versus-character accounting.

## 3. `comments.json` object counts and composition

`comments.json` is pretty-printed. Its raw/pretty size was 73,421,300 bytes, compact size 68,331,873 bytes, and gzip size 6,871,051 bytes.

The compact comment payload breaks down as follows:

| Component | Bytes | Approximate share of compact comments |
|---|---:|---:|
| Anchor history | 66,907,814 | 97.91% |
| Patch impacts | 1,110,488 | 1.63% |
| Current anchors | 227,037 | 0.33% |
| Threads | 68,105 | 0.10% |
| Recovery history | 62 | negligible |
| Other metadata | 13,767 | 0.02% |

`anchorContextBytes` totals 195,024 but is a subfield of current-anchor bytes and must not be added again. `relatedPatchMetadataBytes` is the same persisted patch-impact category and likewise must not be double-counted.

Whitespace accounts for 5,089,427 bytes, or 6.93% of the raw file. It is measurable but not the cause. Gzip reducing 73.4 MB to 6.87 MB is further evidence that repetition, not unique content, dominates.

## 4. Per-comment size ranking

The median compact comment was 241,254 bytes; average 2,204,252.94; smallest 6,689; largest 18,950,292. The largest comment occupies 27.73% of compact comment data and the largest five occupy 72.09%.

Top ten comments:

| Comment | Type | Status | Total | Thread | Anchor | Context* | History | Impacts | Recovery | Other |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `PM-COMMENT-0025` | note | resolved | 18,950,292 | 4,439 | 2,313 | 938 | 18,428,424 | 514,278 | 2 | 688 |
| `PM-COMMENT-0021` | question | resolved | 13,932,407 | 4,024 | 2,689 | 1,539 | 13,411,760 | 513,426 | 2 | 358 |
| `PM-COMMENT-0039` | question | resolved | 5,796,338 | 2,390 | 1,593 | 490 | 5,785,980 | 5,873 | 2 | 352 |
| `PM-COMMENT-0038` | question | resolved | 5,342,303 | 2,302 | 1,333 | 345 | 5,333,913 | 4,191 | 2 | 414 |
| `PM-COMMENT-0020` | question | resolved | 5,241,814 | 4,779 | 1,526 | 500 | 5,226,818 | 7,953 | 2 | 588 |
| `PM-COMMENT-0018` | question | resolved | 4,681,897 | 3,435 | 1,619 | 629 | 4,670,040 | 6,306 | 2 | 347 |
| `PM-COMMENT-0016` | question | resolved | 3,464,953 | 4,889 | 2,016 | 918 | 3,451,427 | 6,091 | 2 | 380 |
| `PM-COMMENT-0015` | question | resolved | 3,188,839 | 6,850 | 2,107 | 1,004 | 3,173,079 | 6,105 | 2 | 548 |
| `PM-COMMENT-0013` | question | resolved | 1,852,355 | 2,335 | 37,710 | 36,615 | 1,808,532 | 3,276 | 2 | 352 |
| `PM-COMMENT-0028` | question | resolved | 1,366,382 | 799 | 37,732 | 36,615 | 1,325,600 | 1,726 | 2 | 375 |

`Context*` is included inside `Anchor`, not additional storage. The machine-readable audit reports the same categories for all 31 comments without printing private content.

## 5. Field-path size ranking

| Field path | Occurrences | Total bytes | Average | Maximum |
|---|---:|---:|---:|---:|
| `comments[].anchor_history[].previous_anchor.anchor_context.markdown_text` | 5,287 | 15,337,566 | 2,901.00 | 65,533 |
| `comments[].anchor_history[].new_anchor.anchor_context.markdown_text` | 5,247 | 14,257,852 | 2,717.33 | 65,533 |
| `comments[].anchor_history[].previous_anchor.anchor_context.plain_text` | 5,287 | 11,408,647 | 2,157.87 | 46,300 |
| `comments[].anchor_history[].new_anchor.anchor_context.plain_text` | 5,247 | 10,661,835 | 2,031.99 | 46,300 |
| `comments[].anchor_history[].previous_anchor.selected_text` | 5,287 | 1,082,949 | 204.83 | 5,885 |
| `comments[].anchor_history[].new_anchor.selected_text` | 5,247 | 1,054,462 | 200.96 | 3,068 |
| `comments[].anchor_history[].previous_anchor.context_after` | 5,287 | 873,901 | 165.29 | 168 |
| `comments[].anchor_history[].new_anchor.context_after` | 5,247 | 867,314 | 165.30 | 168 |
| `comments[].anchor_history[].previous_anchor.context_before` | 5,287 | 864,300 | 163.48 | 166 |
| `comments[].anchor_history[].new_anchor.context_before` | 5,247 | 857,766 | 163.48 | 166 |
| `comments[].anchor_history[].previous_anchor.containing_heading_path[]` | 12,965 | 559,176 | 43.13 | 63 |
| `comments[].anchor_history[].new_anchor.containing_heading_path[]` | 12,878 | 555,393 | 43.13 | 63 |
| `comments[].patch_impacts[].note` | 5,058 | 427,234 | 84.47 | 142 |

Complete previous and new anchors are copied into every transition. Their Markdown and plain-text contexts alone account for most of the file.

## 6. Repeated-value analysis

- Hashing substantial strings estimates 31,667,588 duplicate string bytes. Keeping one instance of each repeated string would reduce compact storage from 68.33 MB to roughly 36.66 MB before accounting for repeated object structure.
- A 399-byte selected/context value occurs 4,618 times and contributes 1,842,183 duplicate bytes.
- A 212-byte value occurs 6,928 times and contributes 1,468,524 duplicate bytes.
- A 170-byte value occurs 6,924 times and contributes 1,176,910 duplicate bytes.
- Near-document Markdown contexts of 61,269 and 60,961 bytes each occur 16 times, contributing 919,035 and 914,415 duplicate bytes respectively.
- A repeated patch-impact note of 88 bytes occurs 4,627 times, contributing 407,088 duplicate bytes.
- Full anchor objects recur hundreds to more than one thousand times; exact timestamps prevent whole history entries from being byte-identical even when their semantic transitions repeat.
- The audit found 104 historical contexts at least 80% of current document length, totaling 6,334,058 bytes. A broader half-document threshold found 301 large contexts totaling 14,376,749 bytes. None was byte-identical to the current full document; they are oversized root-heading or containing-section contexts.

No private repeated value is printed; the audit reports hashes, lengths, counts, and field paths only.

## 7. Recursive-history findings

No recursive or exponential nested structure was found:

- no `anchor_history` inside stored historical anchors;
- no recovery entry containing a complete comment;
- no patch impact containing complete prior impacts or patches;
- no nested previous/current historical arrays;
- no recursively embedded comments or patch arrays.

The amplification is linear per recorded transition, but pathological in aggregate: every transition stores two full anchors, some anchors contain 40–65 KB section contexts, and two comments repeatedly alternate between equivalent states thousands of times. This is repeated full-snapshot amplification, not recursive nesting.

## 8. Anchor-history findings

There are 5,381 entries occupying 66,907,814 bytes. There are 753 unique semantic transitions, 4,628 repeated transitions, 4,616 ping-pong transitions, and six entries with no effective anchor change.

The two dominant loops are:

- `PM-COMMENT-0021`: 2,368 history entries, 2,349 impacts, only 64 unique transitions, 2,301 ping-pong transitions. `PM-PATCH-0043` appears in 2,310 linked impacts.
- `PM-COMMENT-0025`: 2,373 history entries, 2,353 impacts, only 67 unique transitions, 2,301 ping-pong transitions. `PM-PATCH-0048` appears in 2,310 linked impacts.

During the main loop each comment records matched A→B/B→A and C→D/D→C transition pairs hundreds of times, with synchronized timestamps and peaks around 36 entries per minute. This cannot be explained by human editing. It is repeated validation/recovery persistence.

Other comments have smaller, mostly meaningful histories, but `PM-COMMENT-0038` and `PM-COMMENT-0039` captured root-heading contexts extending approximately 56–65 KB. Their current anchors are small; the oversized data survives only in history.

Ordinary typing did not write files in the browser audit. The dominant history was added by revalidation/recovery and patch transformation, not every keystroke or visual projection. Existing records lack an editing-session or mutation-generation identifier, so routine manual-edit coalescing cannot be inferred safely after the fact.

## 9. Patch-impact findings

- 5,166 impacts occupy 1,110,488 bytes.
- 4,617 are semantic duplicates even though timestamps make exact serialized entries unique.
- `PM-COMMENT-0021` and `PM-COMMENT-0025` each contain 2,307 semantically duplicate impacts.
- Impact entries are small and contain patch ID, timestamp, impact kind, result, and note. They do not contain full patch objects, replacement text, anchors, sections, or prior impact arrays.
- Most comments have append-only meaningful impacts. The accidental amplification is concentrated in the same repeated recovery loop.

Patch impacts are not the primary size cause, but idempotency by `(patch_id, impact_kind, result)` would save approximately 1.01 MB on this fixture.

## 10. Thread and system-message findings

- 233 thread entries total: 193 system, 36 ChatGPT, four user.
- Serialized audit size including comment attribution: 74,831 bytes; actual persisted per-comment thread arrays total 68,105 bytes.
- System entries account for 48,795 audited bytes, ChatGPT replies 23,006, and user replies 3,030.
- The original 31 comment texts total 3,471 bytes.
- Seven source references use 586 URL bytes, 915 support-description bytes, and 337 title bytes.
- Ninety-nine system messages are globally duplicated. All 193 system entries are technical, but the entire technical-message category is only about 49 KB.

Some anchor/patch events are represented both in structured metadata and human-visible system messages. That duplication is real but negligible relative to anchor history. Human comments, user replies, ChatGPT replies, sources, resolution actions, and meaningful patch events must be preserved.

## 11. Runtime-data persistence findings

No persisted field matched runtime-only concepts such as `rect`, `top`, `bottom`, `dom`, `element`, `projection`, `visual_match`, candidate lists, layout, performance, debug, or cache. DOM elements, visual indexes, browser rectangles, rail positions, projection candidates, calculated applicability, and React state are not causing file growth.

## 12. Complete save-path map

Core file writing is centralized in `lib/project/patchmark-project.ts`. Every critical write ultimately calls `createWritable()`, `write()`, and `close()` without an app-level temporary name, rename, fsync, generation check, queue, or stale-write guard.

| Trigger | Functions/files | Serialized data and order | Protection/error behavior |
|---|---|---|---|
| Project open/normalization | `openProjectFolder` → `ensureProjectMetadata` | Rewrites manifest even if unchanged; creates absent metadata files/directories | Parse errors reject; no no-op hash check |
| Explicit Save | `handleSaveChanges` → `saveProjectDocument`, then `writeProjectComments` | `document.md` → manifest → normalized, pretty comments | UI reports failure, but earlier files remain committed |
| Manual edits | React Markdown state and local browser draft | No project-file write until explicit Save | Browser draft protects Markdown only |
| Comment create/edit/reply/resolve | `persistComments` → `writeProjectComments` | Whole normalized, pretty `comments.json` | `isCommentBusy` serializes comment actions only |
| Background comment self-healing/convergence | recovery effect → `writeProjectComments` | Whole comments file | Idle/deferred; cancellation prevents later state update but does not abort an already-started close |
| Background patch recovery | patch recovery effect → `writeProjectPatches` | Whole patches file | Same fire-and-forget stale-close risk |
| Patch acceptance | pre-apply snapshot → manifest → document → manifest → patches → comments | Five independently committed file writes across four logical resources | Explicit partial-state messages; no rollback |
| Patch re-anchor | `writeProjectPatches` | Whole patches file | Independent write |
| Patch/group reject | patches, then optional linked comment thread | Whole patches then whole comments | Patch rejection can persist while thread update fails |
| ChatGPT import | raw import archive, optional patches, then comments | Import → patches → comments | Strict validation occurs first, but later write failure can leave partial import |
| Snapshot create | snapshot Markdown, then manifest | Snapshot file → manifest | Content hash suppresses duplicate snapshots; no cross-file transaction |
| Snapshot view/compare | read only | No restoration write path was found | Snapshots restore Markdown manually only, not metadata |
| Context pack/export | direct sidecar write | Export text | Independent write |

Relevant production locations are `lib/project/patchmark-project.ts:129`, `lib/project/patchmark-project.ts:216`, `lib/project/patchmark-project.ts:402`, `lib/project/patchmark-project.ts:447`, `lib/project/patchmark-project.ts:493`, `lib/project/patchmark-project.ts:536`, `lib/project/patchmark-project.ts:601`, and `lib/project/patchmark-project.ts:729`. UI orchestration is at `components/document-editor.tsx:750`, `components/document-editor.tsx:812`, `components/document-editor.tsx:892`, `components/document-editor.tsx:1241`, `components/document-editor.tsx:2145`, `components/document-editor.tsx:2992`, and `components/document-editor.tsx:3642`.

## 13. No-op write results

Production-browser instrumentation against the copied fixture found zero writes for:

- activate/deactivate a comment;
- Find;
- scroll;
- open patch review;
- open PDF preview;
- canonical validation and settled historical convergence;
- harmless rerender;
- mode switching.

Two unnecessary cases remain:

- Project open and reload each rewrote the unchanged 15,932-byte manifest once.
- Save without changes rewrote `document.md`, manifest, and the full comments file: three writes, 73,504,634 bytes, one 73,421,299-byte stringify, and 1,146.21 ms interaction time.

The read-only UI is generally quiet, but explicit no-op Save has severe write amplification and project open performs a smaller unnecessary manifest write.

## 14. Rapid-edit write results

Seventy-five rapid edits produced 75 performance records but zero serialization operations and zero filesystem writes before explicit Save. Patchmark does not write the 70 MB file per keystroke.

The explicit Save then performed three writes totaling 73,334,363 bytes, including one 73,250,953-byte comments serialization taking 219 ms. The in-memory file server's final data matched the current UI state. Maximum observed concurrent active writes was one in this path, but this does not provide global ordering across background effects and independent actions.

## 15. Serialization and persistence profile

Seven Node runs on the real copied comments payload:

| Stage | Median ms | p95/max ms | Bytes processed |
|---|---:|---:|---:|
| JSON parse | 112.89 | 188.22 | 73,421,300 |
| Structured clone | 151.90 | 176.75 | in-memory object |
| Compact stringify | 232.90 | 354.12 | 68,331,873 |
| Pretty stringify | 191.76 | 220.43 | 73,421,300 |
| SHA-256 | 78.12 | 108.51 | 73,421,300 |
| Gzip | 855.70 | 970.80 | 73,421,300 |
| Filesystem write | 204.55 | 230.80 | 73,421,300 |
| Filesystem read | 18.23 | 20.08 | 73,421,300 |
| Total pretty save | 470.87 | 553.01 | 73,421,300 |

Browser measurements isolate production behavior: a real no-op comments stringify took 206.9 ms; explicit post-edit stringify took 219 ms. Normalization was proxied by instrumenting comment-array maps: the maximum was 7.2 ms during no-op Save and 5.7 ms after rapid edits, so normalization is not the long-task source. Project load took 1,289.58 ms and reload 1,499.77 ms. Five long tasks were observed, median 202 ms and maximum 604 ms.

There is no rename stage to time. Project refresh/reload includes UI and MDXEditor work and therefore is not directly comparable to raw parse timing.

For comparison:

- The same 31 current comments with history/impacts stripped were 273,432 pretty bytes and saved in 1.46 ms median, 1.91 ms p95.
- A three-comment synthetic project was 1,795 pretty bytes and saved in 0.06–0.07 ms median.

This distinguishes constant overhead from pathological persisted structure: the present long tasks scale with the 73 MB payload.

## 16. Pretty-printing cost

Pretty output adds 5,089,427 bytes over compact JSON, about 6.93% of raw size. Parse/stringify timings did not show indentation as the dominant cost. Compact JSON would still be 68.33 MB. Switching formatting would be a minor optimization and would not address the repeated history.

## 17. Stale asynchronous write findings

Production code has no project-wide promise chain, mutation generation, abortable write, commit token, or stale-close guard. React effect cleanup only prevents post-write state updates; it does not cancel a `createWritable().close()` already in progress.

A delayed deterministic fixture completed generation 11 first and generation 10 second. Final persisted contents were generation 10, proving that an older write can overwrite newer state if independently started writes overlap.

The browser audit observed at most one active write in the exercised normal paths, but that is an observation, not a guarantee. Background comment recovery, background patch recovery, Save, patch actions, and comment actions are not coordinated by one queue.

## 18. Document/comment generation consistency

No persisted `document_hash`, `document_sha256`, `mutation_generation`, `save_generation`, `save_id`, document version, or equivalent cross-file commit identity exists in the real project. Consistency is inferred from operation order and successful promises only.

This allows both directions of mismatch:

- document generation N+1 with comments generation N after document succeeds and comments fails;
- comments generation N+1 with document generation N when metadata recovery persists against unsaved in-memory Markdown or when writes are independently invoked.

Background recovery can derive comments from dirty in-memory Markdown and persist comments without persisting `document.md`. This is a direct comments-new/document-old risk.

## 19. Atomic-write findings

Each file uses the browser File System Access API's `createWritable`/`write`/`close`. Browser implementations commonly stage a single-file replacement internally, which is safer than a raw truncating stream, but Patchmark itself does not create an identifiable temporary file, fsync, rename, verify, retain a backup, or commit multiple resources atomically.

Consequences:

- app-level cross-file atomicity is absent;
- old and new generations can be mixed after failure;
- platform-specific replacement and rename semantics are delegated to the browser;
- Patchmark has no explicit temporary-file cleanup or commit recovery protocol;
- a browser/process exit during a logical multi-file operation has no manifest-level recovery marker.

A database is not required. A file-project-appropriate solution is versioned sidecars or backup-before-replace plus a manifest commit pointer written last.

## 20. Backup and recovery findings

1. Invalid `comments.json` is rejected with an explicit error; Patchmark cannot automatically recover the metadata.
2. The editor loads the document but clears comments state and reports the error. There is no dedicated safe read-only metadata recovery workflow.
3. Invalid JSON is not automatically normalized or overwritten; the source remained unchanged in the test.
4. No last-known-good comments or patches file is retained.
5. Snapshots contain Markdown only and cannot reconstruct comments, threads, anchors, impacts, or patch status.
6. Raw ChatGPT imports preserve imported payloads, but not all later metadata evolution.
7. Browser drafts protect Markdown only.
8. No automatic backup exists before future compaction because compaction is not yet implemented.

## 21. Partial-write simulations

Deterministic simulations proved:

| Scenario | Final result |
|---|---|
| Document succeeds, comments fails | document generation 2; comments generation 1 |
| Comments succeeds, document fails | document generation 1; comments generation 2 |
| Patches succeeds, comments fails | patches generation 2; comments generation 1 |
| Newer write closes, then older write closes | stale older generation wins |
| Invalid JSON reload | parse rejected; source unchanged |
| Temporary file remains | none, because the app creates no explicit temp file |

The production-browser failure injection after `document.md` and manifest writes reproduced the real Save ordering: 83,428 bytes completed, the 73,250,953-byte comments write failed, and UI feedback was `Save failed: Injected fixture write failure: .patchmark/comments.json`.

Patch acceptance has an additional documented partial state: `document.md` may already contain the patch while `patches.json` fails, and patches may succeed while linked comments fail.

## 22. Dry-run compaction estimates

All rules were calculated independently and are not additive. No rule was applied.

| Rule | Eligible records | Projected compact bytes | Bytes saved | Reduction | Information/recovery assessment |
|---|---:|---:|---:|---:|---|
| A. Exact consecutive duplicates | 0 | 68,331,893 | 0 | 0% | Timestamps make entries unique; future semantic comparison is needed |
| B. No effective anchor change | 6 | 67,588,799 | 743,074 | 1.09% | Safe after retaining event reason separately; existing data should be backed up first |
| C. Nested history arrays | 0 | n/a | 0 | 0% | Prevention invariant only; no current recursion |
| D. Concise transition evidence | 5,381 | 9,187,297 | 59,144,576 | 86.55% | Preserve reason/time/patch/impact, hashes, ranges, context kind/IDs; historical verbatim context must remain in backup or version reference |
| E. Coalesce manual-edit session shifts | 0 safely inferable | 68,331,893 | 0 | 0% | Existing records lack session/generation IDs; future data only |
| F. Duplicate technical messages equivalent to metadata | 0 under conservative per-comment/patch rule | 68,331,873 | 0 | 0% | Global duplicates exist but only about 49 KB; future event dedupe only |
| G. Duplicate patch impacts | 4,617 | 67,320,588 | 1,011,285 | 1.48% | Preserve first/last timestamps and human-visible event; existing migration low risk with backup |
| H. First/last repeated transition evidence | 4,584 | 51,082,301 | 17,249,572 | 25.24% | Preserves endpoints but loses intermediate recurrence count unless aggregated; existing migration needs count/timestamp summary |

Rule D is the decisive architectural change. It should apply to future writes immediately. Applying it to existing history requires a copied-project migration, byte-for-byte backup, hashes, reopen validation, and explicit user approval.

## 23. Data-preservation requirements

Non-negotiable persisted data:

- original comment text;
- user and ChatGPT replies and sources;
- comment status, timestamps, IDs, linkage, and human resolution actions;
- current anchor and last stable anchor;
- meaningful anchor transitions;
- directly linked patch evidence;
- patch impacts necessary to explain current state;
- accepted/rejected/stale patch history;
- enough bounded evidence for historical self-healing.

Compaction may replace duplicated historical verbatim context with hashes, canonical ranges, structural identifiers, short bounded excerpts, counts, and version/snapshot references only after recovery tests prove equivalence.

## 24. Storage options considered

### Option 1 — Keep one JSON file and reduce duplication

Lowest compatibility and migration risk. A projected approximately 9.19 MB compact file is manageable, but whole-file writes remain. Recommended now.

### Option 2 — Current state plus append-only history JSONL

Reduces current-state rewrite cost and supports append. Adds truncation recovery, indexing, compaction, cross-file generation, and migration complexity. Consider only if bounded history still grows materially.

### Option 3 — One file per comment

Reduces write amplification and corruption scope. Thirty-one files is acceptable, but patch actions touch multiple comments and require a commit protocol. Not needed for Phase 7B.

### Option 4 — Small local database

Provides transactions and indexes but adds browser portability, backup/export, migration, and packaging complexity. Overengineering for the present evidence.

### Option 5 — Content-addressed shared context blobs

Could reclaim the measured 31.67 MB of duplicate strings, but introduces reference integrity, garbage collection, migration, and recovery complexity. Defer.

## 25. Recommended architecture

Keep one JSON file for now, but change the persistence contract:

1. Store full current and last-stable anchors only.
2. Store concise history evidence: reason, timestamp, source patch/mutation, old/new canonical range, structural heading/table/row IDs, selected/context hashes, bounded excerpts, and optional snapshot/version reference.
3. Reject no-op semantic transitions and idempotently record patch impacts.
4. Add `schema_version`, `save_generation`, and `document_hash` to comments/patch envelopes and committed generation/hashes to the manifest.
5. Route all project writes through one per-project ordered queue. Skip a stale queued generation before close.
6. Commit logical multi-file saves by writing/verifying resources first and updating a manifest commit pointer last.
7. Suppress unchanged comments/patches/manifest writes using canonical serialized hashes; stop rewriting manifest on read-only open.
8. Prevent background recovery from persisting against a dirty document unless it participates in the same document generation.
9. Retain last-known-good sidecars or versioned generation files until the next successful open verifies the commit.

This keeps Patchmark a transparent file project and avoids a database.

## 26. Smallest safe Phase 7B implementation

The smallest bounded implementation should be:

1. **Stop future amplification:** concise anchor history, semantic no-op guard, repeated-transition/ping-pong guard scoped to one mutation source, and idempotent patch impacts.
2. **Suppress no-op writes:** hash canonical normalized serialization and skip unchanged comments, patches, and manifest; avoid manifest write during unchanged project open.
3. **Order writes:** one per-project queue with monotonic generation/save ID and stale-generation suppression.
4. **Record consistency:** document hash and save generation in comments/patches envelopes; manifest commit generation and hashes written last.
5. **Protect recovery writes:** do not independently persist recovered metadata derived from unsaved Markdown.
6. **Add last-known-good protection:** verified generation sidecars or backup-before-replace with startup validation.

Rapid-edit coalescing is not urgent because the current editor performs zero project writes during 75 rapid edits. A database, per-comment files, JSONL, and content-addressed blobs are outside the smallest safe scope.

## 27. Proposed migration and compaction strategy

Do not auto-compact on project open. Provide an explicit copied-project tool:

1. require a destination copy, never the live path by default;
2. create a byte-for-byte backup of comments, patches, manifest, document, imports, and versions;
3. record pre-migration size and SHA-256 inventory;
4. dry-run each rule and report eligible records and information loss;
5. convert history to the new schema while preserving current/last-stable anchors and transition summaries;
6. deduplicate patch impacts while preserving first/last timestamps and occurrence count;
7. write versioned output, parse it, validate IDs/linkage/hashes, and run anchor/projection/recovery tests;
8. reopen through production Patchmark against the copy;
9. compare canonical resolution and comment/patch counts;
10. require explicit confirmation before replacing live metadata;
11. retain the original backup and a compaction audit record.

Existing history should never be discarded solely because it is large.

## 28. Risks

- Over-aggressive concise evidence could weaken historical self-healing.
- A migration crash could leave mixed schemas unless the manifest commit protocol lands first.
- Generation-pointer bugs could select an older but valid sidecar.
- File System Access API rename/support differences require browser-tested versioned-file semantics.
- Legacy projects have no generation metadata and need a generation-zero migration path.
- A ping-pong guard must distinguish accidental validation loops from real user edits that intentionally alternate content.
- Hash/no-op comparison must use canonical normalized serialization, not unstable object insertion order.
- Backups contain private document/comment data and must remain local and user-controlled.

## 29. Diagnostic scripts and tests added

- `scripts/persistence-size-audit.mjs`: deterministic file, field-path, repeated-value, recursion, history, impact, thread, dry-run, and benchmark report.
- `scripts/persistence-size-audit.test.mjs`: synthetic size, duplicate-history, no-op-history, impact-dedup, and dry-run assertions.
- `scripts/persistence-browser-audit.mjs`: production browser no-op, rapid-edit, serialization, long-task, and partial-save instrumentation.
- `scripts/persistence-consistency-audit.test.mjs`: out-of-order, partial-write, malformed-JSON, generation-metadata, and temporary-file diagnostics.
- `scripts/comment-rail-editor-browser-regression.test.mjs`: test-fixture write logging, delay/failure injection, and active-write counters; production app behavior is unchanged.
- `package.json`: commands for the persistence audit diagnostics.

The diagnostic suite covers size breakdown, recursive history detection, semantic duplicate detection, no-op writes, rapid edits, out-of-order closes, partial writes, invalid JSON, missing generation metadata, and dry-run compaction.

## 30. Temporary artifacts

Created during the audit:

- `/private/tmp/patchmark-phase7a-fixture`
- `/private/tmp/patchmark-phase7a-small-fixture`
- `/private/tmp/patchmark-phase7a-build-source`
- `/private/tmp/patchmark-phase7a-audit`
- dedicated production server on `127.0.0.1:3117`

The dedicated server was stopped and the copied fixtures, disposable build, benchmark output, screenshots, and temporary audit reports were removed after this report and final validation were complete. No user server or live-project data was removed.

## 31. Safety confirmations

- Live project data was unchanged. Final exact SHA-1 inventories matched the pre-audit inventory for all 74 files.
- The copied fixture also remained byte-identical because production-browser writes were held in memory.
- No live or copied project compaction or rewrite was performed.
- No history, impacts, threads, snapshots, imports, or versions were deleted.
- No commit was made.

## 32. Final recommendation

Current comments.json size:  
73,421,300 pretty/raw bytes; 68,331,873 compact bytes; 6,871,051 gzip bytes.

Primary size cause:  
5,381 anchor-history entries storing complete previous/new anchors and repeated Markdown/plain containing-section contexts. Anchor history is 66,907,814 bytes, approximately 97.91% of compact comments.

Secondary size causes:  
Two validation/recovery ping-pong loops contribute thousands of repeated transitions and patch impacts; several histories retain 40–65 KB root-heading contexts. Pretty whitespace adds 5.09 MB and patch impacts add 1.11 MB, but neither is primary.

Is growth legitimate or accidental:  
The underlying need for meaningful transformation history is legitimate. The magnitude is accidental: repeated deterministic recovery/validation transitions, duplicated full context snapshots, and semantically duplicate impacts. No recursive nested-history structure was found.

Current write amplification:  
No-op Save writes 73,504,634 bytes across document, manifest, and comments and takes about 1.15 seconds in the production browser. Seventy-five edits cause no project writes until Save, so the amplification is per save/recovery write, not per keystroke.

Current consistency risks:  
No cross-file generation metadata, no global write queue, no stale-close guard, no logical transaction, no last-known-good metadata, unnecessary manifest writes on open, and independently persisted recovery derived from in-memory Markdown. Partial and stale generations were reproduced.

Recommended Phase 7B:  
Keep one JSON file; store concise history evidence, prevent semantic no-op/ping-pong amplification, make patch impacts idempotent, suppress unchanged writes, add a per-project generation-ordered queue, persist document/hash generation metadata, commit via manifest last, and retain last-known-good generation files.

Compaction approach:  
Explicit copied-project dry run with byte-for-byte backup, hashes, per-rule report, schema migration, parse/linkage/canonical-resolution validation, production reopen, user confirmation, and retained original/audit record. Never automatic on open.

What must remain unchanged:  
All human/ChatGPT conversation and sources, comment and patch IDs/status/timestamps/linkage, current and last-stable anchors, meaningful transitions, human resolution actions, accepted/rejected history, and enough bounded evidence for self-healing.

Estimated post-fix size:  
Rule D alone projects approximately 9,187,297 compact bytes, an 86.55% reduction. Impact deduplication could reduce it further but rule estimates are independent. A clean bounded-history project with equivalent current data should be far smaller; 9–10 MB is the conservative migration target until recovery validation proves more compaction safe.

Risks:  
Loss of recovery evidence from over-compaction, partial schema migration, incorrect generation pointers, browser file-semantics differences, legacy migration, false suppression of real alternating edits, and local backup privacy.

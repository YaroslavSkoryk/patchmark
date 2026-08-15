# Multi-Document Switching Performance

Patchmark profiles and optimizes document switching without changing the
authoritative persistence contract.

> Performance optimization must not weaken Patchmark’s save-before-switch,
> document-identity, or recovery guarantees.

## Reproduction Fixture

The automated browser benchmark creates a multi-document Strategy-scale project.
Each large document contains approximately 82–101 KB of Markdown with tables,
links, offscreen anchors, and:

- 31 comments;
- 233 replies;
- 59 patch proposals;
- 49 version entries.

The benchmark measures cold, repeated warm, dirty, bookmark, rapid, missing-file,
save-failure, external-change, and long-session transitions. File-system reads
and writes are recorded by the browser picker fixture. A `PerformanceObserver`
records long tasks, while the switch profiler records phase durations, record
counts, React renders and commits, projection passes, and rail-layout passes.

The required benchmark is deliberately synthetic. Its explicit document,
paragraph, comment, patch, and history counts make correctness and timing samples
reviewable without depending on private project content or machine-local paths.

## Baseline

The baseline showed that disk reads were not individually slow. The cost came
from redundant target-store work, repeated state initialization, anchor-derived
work, rail projection, and a large MDX/Lexical render task.

| Metric | Cold large target | Warm large target |
| --- | ---: | ---: |
| First usable | 2,436.8 ms | 2,589.0 ms median / 2,743.1 ms p95 |
| Secondary complete | 3,277.2 ms | 3,538.0 ms median / 3,911.8 ms p95 |
| Longest task | 1,099 ms | 952 ms median / 1,021 ms p95 |
| File reads | 31 / 1,246,014 bytes | 18 / 700,609 bytes |
| File writes | 11 | 0 |
| React commits | 3 | 2 |
| Anchor summaries | 484.9 ms | 507.5 ms |
| Rail/projection | 556.7 ms | 551.5 ms |
| Review-state load | 833.2 ms | 737.9 ms |
| Navigator load | 1,003.2 ms | 893.5 ms |

The original cold transition also exposed a correctness-related performance bug:
Visual Mode's initial normalization could be reported as a manual edit. That
created recovery/save work for unchanged Markdown and invalidated exact source
offset assumptions used by comment-anchor resolution.

The baseline benchmark used the profiler's then-current first-usable mark. The
optimized benchmark additionally waits until the target title and target body are
both present in the editable DOM. Comparisons are therefore conservative but not
perfectly identical timing methods.

## Switch Phase Model

The development profiler records these phase groups where applicable:

```text
switch requested
→ current editor flushed
→ source recovery preserved when dirty
→ current authoritative state persisted or proven unchanged
→ target ownership validated
→ target Markdown, manifest, current review store, and save commit read
→ target integrity validated
→ target recovery and device-local UI state evaluated
→ current review state deserialized
→ target state committed to React
→ editor initialized and first target render observed
→ first usable editor observed
→ rail, highlights, bookmark geometry, and secondary work settled
```

The profiler is disabled by default. Enable either query parameter:

```text
?patchmarkSwitchPerformance=1
?patchmarkPerformance=1
```

Records are available at:

```js
window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__.getRecords()
```

The in-memory diagnostic buffer is bounded to 200 operations and emits no
production console logging.

## Critical Path

The required pre-edit path remains:

1. Capture device-local UI state and the latest switch token.
2. Preserve dirty Markdown recovery as a best effort.
3. Complete the normal atomic authoritative save, or prove it is a no-op.
4. Reject stale switch completions.
5. Validate the target's registered path and document ownership.
6. Read and validate target Markdown and the current document store.
7. Evaluate only the target document's pending recovery decision.
8. Load current comments, patches, and lightweight version metadata.
9. Commit target editor, review, navigator, and UI state together.
10. Initialize the editor and expose it as editable.

The following work is secondary:

- comment-rail measurement and placement;
- visual highlight and reading-bookmark geometry;
- delayed bookmark scrolling after the target editor commits;
- device-local recent-project metadata refresh;
- background stale-anchor recovery.

Secondary work never binds source-document comments to target-document content.

## Implemented Optimizations

### No-op persistence

- An unchanged switch retains the save barrier but serializes and writes no
  Markdown or review files.
- Already validated in-memory comments and patches are reused as authoritative
  references instead of being parsed again during the same open transaction.
- Existing validated commit descriptors prevent equivalent content hashes from
  being recomputed within the transaction.
- An unchanged switch does not create a version, snapshot, generation, manifest
  write, or recovery-record churn.
- Dirty Markdown still creates document-scoped recovery first, completes the
  atomic save, and clears only that matching recovery after success.

### Target-only loading

- Opening a registered document validates and attempts only its registered path;
  it no longer scans every registered Markdown file.
- A known in-session local project instance reads only the target recovery record
  instead of listing all document recoveries.
- The navigator list is reused when the portable manifest revision is unchanged.
- Missing-file switching reads only the target metadata needed to display the
  missing state.

### Batched initialization

- Target review parsing, navigator preparation, and recovery/UI-state loading run
  concurrently.
- Markdown, comments, patches, versions, navigator state, mode, selection, and
  recovery presentation are committed in one target-state update rather than a
  clear/load/reload sequence.
- A single MDXEditor instance is reused across documents. Programmatic document
  resets clear Lexical undo/redo history so undo cannot cross document identity.
- Initial MDX normalization is not propagated as a user edit; source Markdown
  remains authoritative and exact comment offsets remain valid.

### Responsive switching UI

- The requested navigator item is marked immediately and shows `Opening…`.
- The previous editor becomes read-only and document-mutating controls remain
  disabled until the target is valid.
- Other document selection buttons remain available, allowing A → B → C requests;
  stale async completion is ignored and C wins.
- Requesting a document in a collapsed group expands that group in device-local
  UI state without writing the project manifest.

## Version History

Normal switching reads current version metadata from `manifest.json`; it does not
read files under `versions/*.md`. Historical bodies remain authoritative and are
loaded by Version History compare/restore flows when requested. Snapshot creation,
compare, restore, IDs, and last-known-good behavior are unchanged.

## Recovery, Groups, and Bookmarks

- Recovery remains keyed by local project instance, `project_id`, and
  `document_id`.
- A failed authoritative save leaves the current document active and its recovery
  available. The target is not partially activated.
- Recovery cleanup runs only for a recovery record actually preserved for that
  save, and only after authoritative success.
- Group membership never enters document or review-object identity.
- Collapsed-group expansion is local UI state and causes no manifest write.
- Continue reading uses the same target-only switch pipeline, then restores the
  owning document's bookmark after the target editor commits.

## Cache Decision

No document working-state or serialized editor-state cache was added. Measured
target reads are only a few milliseconds, while the remaining dominant task is
MDX/Lexical document construction. A prototype serialized Lexical-state cache did
not reliably reconcile target content and was rejected rather than weakening
document isolation. Every switch therefore re-reads and validates authoritative
target files, so external changes cannot be hidden by a stale cache.

The safe optimization is reuse of one editor instance, not retention of multiple
authoritative or dirty document states.

## Optimized Results

On the same development machine, the six-sample large-to-large benchmark and
60-transition stress run produced:

| Metric | Cold large target | Warm large target | 60-switch stress |
| --- | ---: | ---: | ---: |
| First usable | 1,519.4 ms | 1,373.0 ms median / 1,442.6 ms p95 | 395.3 ms median / 824.1 ms p95 |
| Secondary complete | 1,920.8 ms | 1,688.4 ms median / 1,728.4 ms p95 | 535.4 ms median / 1,146.4 ms p95 |
| Longest task | 1,052 ms | 994 ms median / 1,040 ms p95 | 182 ms median / 703 ms p95 |
| File reads | 6 / 238,211 bytes | 6 / 238,211 bytes | 6 / 241,837 bytes median |
| File writes | 0 | 0 | 0 median |
| React commits | 1 | 1 | 1 median |
| Anchor summaries | 0 ms | 0 ms | 0 ms median |
| Rail/projection | 116.8 ms | 116.3 ms | 0.5 ms median |

The cold target is closely approached. The dedicated warm large-to-large sample
does not meet the 500 ms target, and the measured improvement is below 70% for
that strict sample. The 60-transition warmed-session median is under 500 ms and
improves about 72% from the 12-transition baseline stress median, but its p95 is
still above 800 ms.

## Remaining Limitation

Large Visual Mode documents still produce an approximately 0.8–1.1 second main-
thread MDX/Lexical construction task. Markdown normalization itself is below one
millisecond, file reads are small, current-store validation is a few milliseconds,
and review/anchor derivation is no longer dominant. Further improvement requires
work inside editor construction or a separately proven safe rendering strategy;
it should not be attempted by skipping file validation, recovery, review state,
or the save barrier.

## Commands

Run focused instrumentation tests:

```bash
npm run test:document-switch-performance
```

Start the app and run the generated browser benchmark:

```bash
npm run dev -- --hostname 127.0.0.1 --port 3120
PATCHMARK_EDITOR_URL=http://127.0.0.1:3120 \
PATCHMARK_SWITCH_SAMPLES=6 \
PATCHMARK_SWITCH_STRESS_TRANSITIONS=60 \
PATCHMARK_SWITCH_PERFORMANCE_OUTPUT=/tmp/patchmark-switch-after.json \
npm run test:document-switch-performance-browser
```

The browser benchmark always creates and removes its own deterministic project,
fixture server, and Chrome profile. Arbitrary private projects are not accepted as
test inputs; timing output therefore remains comparable and privacy-safe.

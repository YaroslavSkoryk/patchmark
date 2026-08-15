# Multi-Document Switching

Patchmark treats document switching as an identity-bound transaction. The
transaction preserves save-before-switch, recovery, and local persistence while
preventing document chrome from getting ahead of editor content.

## Display Invariant

The switch model distinguishes:

- the committed project and document identity;
- the latest requested identity and monotonically increasing generation;
- the expected target Markdown fingerprint;
- editor readiness for that exact identity, generation, and switch operation.

The outgoing document remains coherent while target files are read. Once the
target React state commits, the editor surface is interaction-locked until the
identity-bound editor update reports semantic readiness. Visual Mode shows a
non-interactive preview rendered from the target Markdown during that editor
work. It never shows outgoing editor content under target chrome.

Visual Mode reuses one MDXEditor instance so switching does not recreate the
entire plugin and Lexical environment. The target Markdown update is initiated
from a layout-safe lifecycle. A one-shot observer, armed before that update,
accepts only a content mutation associated with the current document key,
request generation, target fingerprint, and operation ID. It does not serialize
the editor or compare the complete canonical Markdown on every mutation.

Markdown Mode uses the controlled textarea value for the same identity-bound
readiness callback. Patchmark rejects stale callbacks, keeps the editor inert,
and suppresses `Opened …` feedback until readiness is proven. The completed
transaction is then cleared so later edits, rewrites, restores, and mode changes
use the editor's normal update lifecycle.

## Switch Milestones

Enable instrumentation with either query parameter:

```text
?patchmarkSwitchPerformance=1
?patchmarkPerformance=1
```

Records are available from:

```js
window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__.getRecords()
```

When profiling is enabled, the latest record is also mirrored to the document
element for isolated browser diagnostics.

The profiler records:

```text
switch requested
→ outgoing document work started/completed
→ target ownership validated
→ target metadata and Markdown read
→ target source available
→ React transaction started
→ target preview visible
→ MDXEditor module available
→ target editor update requested
→ target Markdown parsed
→ first target editor DOM mutation
→ target fingerprint observable
→ semantic readiness callback
→ committed editor visible and interactive
→ switch declared complete
```

It also records file I/O, phase durations, long tasks, React renders and commits,
projection passes, and comment-rail layout passes. The bounded profiler emits no
production console logging.

## Critical Path

The authoritative path remains:

1. Record the latest request generation and outgoing device-local UI state.
2. Preserve dirty recovery and complete the normal atomic save barrier.
3. Reject stale asynchronous completions.
4. Validate the target's registered path and document-store ownership.
5. Read and validate target Markdown, manifest, and current review state.
6. Resolve target recovery and device-local UI state.
7. Commit all target-scoped React state in one transaction.
8. Update the identity-bound editor and show the target-only preview meanwhile.
9. Unlock actions and announce completion only after semantic readiness.

Failure leaves the outgoing document coherent and suppresses success feedback.
Rapid A → B → C switching is latest-request-wins; B cannot commit after C is
requested.

## Proven Failure Mode

The earlier readiness predicate serialized the whole MDXEditor document and
compared it with normalized source Markdown. Real GFM tables can have wide,
source-formatted delimiter rows that MDXEditor canonicalizes on import. The
source and editor serializations are then semantically equivalent but never byte
equivalent. An animation-frame verification loop continued indefinitely while
the correct target DOM remained hidden.

The earlier 100–135 ms result came from a small fixture containing simple
headings and paragraphs. Its source happened to survive the editor round trip,
and the measured milestone did not exercise table canonicalization or expensive
nested code-editor construction. It was not representative of the real
workload.

The corrected implementation:

- removes the unbounded full-document serialization and comparison loop;
- reuses the editor while binding each update to exact switch identity;
- shows a safe target-only preview while MDXEditor performs unavoidable work;
- clears the switch transaction after readiness so later programmatic edits are
  not mistaken for another switch;
- skips unchanged outgoing persistence without weakening dirty save behavior;
- reuses only the validated document-store directory handle, while re-reading
  and validating authoritative target files on every switch.

No document working-state cache or eager project preload is used. External file
changes remain observable.

## Deterministic Benchmark

The browser benchmark creates and removes an isolated three-document project:

- two large, distinct documents with long paragraphs, 26 GFM tables, wide table
  delimiter rows, links, emphasis, inline code, comments, patches, and versions;
- one large document also containing 24 fenced code blocks;
- one small document for large → small and small → large transitions;
- distinct bookmark ownership and an additional missing-file entry.

The large documents are intentionally comparable to the structures that exposed
the real failure without copying private text or paths. The first generated
document is approximately 140 KB.

The benchmark observes every relevant DOM mutation from request through
readiness. It rejects:

- target chrome with visible source-document content;
- a stale or source-document preview;
- premature success feedback;
- interactive stale actions;
- superseded rapid-switch commits.

It covers cold and repeated switches in both directions, large → small, small →
large, dirty save and retry, external changes, missing files, bookmarks, reload,
open secondary surfaces, and rapid A → B → C. Correctness waits are semantic and
contain no fixed sleeps.

## Performance Interpretation

File reads, normalization, and ownership validation are small compared with
MDXEditor construction. Table-heavy documents become visible through the target
preview well before the interactive editor. Documents containing many fenced
code blocks remain slower because each code block constructs CodeMirror-backed
editor state. This is a remaining MDXEditor cost, not readiness polling or a
hidden correctly rendered editor.

Exact timings are machine- and build-dependent. Preserve matched development and
production samples in an evidence archive rather than using a fixed millisecond
threshold as a portable CI contract.

## Commands

Run static instrumentation and fixture-contract checks:

```bash
npm run test:document-switch-performance
```

Run the browser benchmark against an already running app:

```bash
PATCHMARK_EDITOR_URL=http://127.0.0.1:3120 \
PATCHMARK_SWITCH_SAMPLES=8 \
PATCHMARK_SWITCH_STRESS_TRANSITIONS=20 \
PATCHMARK_SWITCH_PERFORMANCE_OUTPUT=/tmp/patchmark-switch.json \
npm run test:document-switch-performance-browser
```

The benchmark uses deterministic fixture data, a task-owned file server, and a
disposable Chrome profile. It does not accept private project paths.

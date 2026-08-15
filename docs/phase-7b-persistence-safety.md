# Patchmark Phase 7B Persistence Safety Report

Date: 2026-07-15

## 1. Git root and branch

- Root: the active Patchmark repository checkout.
- Branch: `develop`
- Work remained in the current checkout and branch.

## 2. Phase 7A audit consumed

`docs/phase-7a-persistence-audit.md` was used as the baseline. The implementation targets its established findings: a 70–74 MB real `comments.json`, approximately 66.9 MB of anchor history, 97.91% history share, repeated full contexts, recovery ping-pong, 73.5 MB no-op rewrites, stale saves, and partial cross-file generations.

## 3. Files changed

- Persistence model and implementation: `lib/project/project-types.ts`, `lib/project/patchmark-project.ts`, `lib/files/file-system-access.ts`.
- Concise history and compatibility: `lib/comments/comment-anchor-history.ts`, `lib/comments/comment-anchor-position.ts`, `lib/comments/canonical-target-resolution.ts`.
- Coordinated UI workflows and recovery read-only state: `components/document-editor.tsx`, `components/visual-markdown-editor.tsx`, `components/mdx-editor-client.tsx`, `components/markdown-source-editor.tsx`, `app/globals.css`.
- Tests/audits: `scripts/concise-anchor-history.test.mjs`, `scripts/persistence-safety.test.mjs`, `scripts/persistence-browser-audit.mjs`, `scripts/comment-anchor-historical-convergence.test.mjs`, `scripts/comment-rail-editor-browser-regression.test.mjs`, `scripts/patch-continuation-browser.test.mjs`, and `package.json`.

## 4. Concise history schema

New entries use `format_version: 2`, a stable `history_id`, cause/reason/source identifiers, optional mutation generation, bounded previous/next states, method/confidence, and optional document hashes. States contain ranges, short excerpts, selected-text hashes, heading identity, and status. They do not contain full comments, full documents, nested history, visual projection data, or recursive anchor contexts.

## 5. Legacy-history compatibility

The persisted type is a mixed union of the existing full-anchor entry and the concise v2 entry. Adapters expose previous, next, and effective anchor state without expanding concise entries. Canonical resolution, position recovery, and historical convergence accept mixed arrays. Loading a legacy project performs no migration write.

## 6. History identity and deduplication

History identity includes the comment, reason/cause, source patch or mutation, previous/next semantic state, and document evidence. No entry is appended for an unchanged effective state, an equivalent latest transition, or an already-recorded source transition.

## 7. Ping-pong prevention

Immediate reverse recovery to stale evidence is rejected when it would recreate the inverse of the latest recovery transition. The current canonical target remains authoritative. The concise-history regression confirms duplicate and A→B→A recovery insertion are prevented.

## 8. History coalescing

Routine validation, activation, Find, projection, rail measurement, and unchanged recovery do not append history. Manual editing updates current anchors in memory; persisted history is limited to meaningful range/state changes and source mutation generations. Patch application and explicit human actions retain separate transitions.

## 9. Deterministic serialization

Comments, patches, and manifests pass through existing normalizers and one stable pretty-JSON representation with a trailing newline. Conversation and history array order is preserved. Commit hashes cover the exact UTF-8 bytes written. Old source bytes remain untouched until a meaningful save.

## 10. No-op write suppression

The project handle caches persisted bytes/descriptors and uses identity fast paths before serialization, followed by deterministic byte/hash comparison when needed. A no-op save returns `unchanged`, does not advance generation, and records file-level debug results. The 73 MB production fixture showed zero serialization and zero writes for load, comment activation/deactivation, Find, scroll, patch review, PDF preview, no-op Save, mode-switch validation, rerender, and reload.

## 11. Save-generation model

`.patchmark/save-commit.json` records format version, monotonic generation, commit ID, creation time, and SHA-256/byte descriptors for `document.md`, `comments.json`, `patches.json`, and `manifest.json`. The manifest mirrors `save_generation` and `save_commit_id`. Generation advances only after a meaningful complete save.

## 12. Ordered write queue

Each directory handle has one FIFO persistence queue and monotonically increasing request IDs. Explicit saves wait for completion. Background/self-healing saves can be superseded, and only the newest relevant complete state is installed and exposed to React state.

## 13. Stale-write behavior

Superseded requests are checked before expensive serialization and again before installation. Temporary files are cleaned, cached hashes are not updated, and stale UI refreshes are skipped. In the 100-request test, 99 requests were superseded, one generation committed, and the newest comment state won. A deliberately delayed older request could not overwrite the newer request.

## 14. Atomic file-write implementation

Critical files are first written to unique sibling temporary files and read back for byte/hash verification. Installation uses the File System Access API `createWritable()` close operation, which provides the browser's target replacement behavior, followed by installed-byte verification. Temporary files are removed after success or failure. Browser File System Access does not expose portable `rename` or `fsync`; verified temporary preparation plus bounded LKG recovery is the chosen durability tradeoff.

## 15. Cross-file commit sequence

The coordinator reads the current complete set, determines changes, serializes deterministic bytes, calculates descriptors, writes one LKG generation, prepares and verifies temporary files, installs data files, installs the manifest, installs commit metadata last, verifies the current set, cleans temporary files, and only then updates in-memory generation/hash state. A partial install without a new commit is detected on reload.

## 16. Last-known-good strategy

One bounded complete generation is stored under `.patchmark/recovery/`: `document.md.lkg`, `comments.json.lkg`, `patches.json.lkg`, `manifest.json.lkg`, and `save-commit.json.lkg`. It is replaced rather than accumulated. For the current legacy 73 MB history this temporarily costs another full comments copy during a meaningful generation; Phase 7C compaction should reduce that cost.

## 17. Startup validation

Projects with commit metadata validate required files, bytes, SHA-256 hashes, JSON arrays, manifest generation/commit identity, and unfinished temporary files. Valid projects clean stale temporary files. Old projects without commit metadata load as generation 0 with baseline hashes and zero writes; their first meaningful save creates generation 1.

## 18. Recovery UX

An inconsistent generation opens read-only with: “Patchmark detected an incomplete project save. The last complete version can be restored.” The user can restore the last complete save or expand technical details. Editors and persistence actions remain disabled during recovery. Restore preserves questionable current files in a timestamped recovery directory before installing the LKG generation.

## 19. Malformed JSON behavior

Malformed current comments or patches are not normalized or overwritten. Startup offers LKG recovery. Browser validation confirmed the exact truncated `comments.json` source remained present before restore, restored comments parsed as an array, and the questionable malformed source was retained for inspection.

## 20. Patch-acceptance durability

Patch acceptance first commits the pre-apply snapshot/manifest generation, then commits transformed Markdown, comments, and accepted patch state as one complete generation. UI state refreshes only after that commit. The coordinator test commits a full accepted-patch state at generation 2 and injects failures at LKG, temporary preparation, document, comments, patches, manifest, and commit stages. The production browser workflow passed apply, retained linked anchor, continuation reply, export/import, lineage, reload, and resolution.

## 21. Comment/self-healing durability

Comment edits, resolution, anchor transformation, convergence, and re-anchor use the same complete-state coordinator. Dirty document state is committed with comment/patch state rather than allowing an anchor generation to race ahead of Markdown. Background convergence is suppressed while the document is dirty and can be superseded by newer work.

## 22. Performance measurements

- 73 MB project load: 1,765.26 ms.
- 100 rapid edits: 100 performance records, no persistence before explicit Save.
- Comment-array mapping during edits: p95 2.3 ms, max 6.4 ms.
- One required 73 MB comments serialization: 164.3 ms.
- Browser long tasks: 5, median 285 ms, p95/max 642 ms; the unavoidable first full legacy generation copy dominates.
- Focused edit benchmark: second-half p95 0.07 ms across 100 repeated edits.

## 23. Serialization/write counts before and after

- Phase 7A no-op Save: approximately 73.5 MB rewritten.
- Phase 7B no-op Save on the real copy: 0 serialization operations, 0 writes, 0 bytes.
- 100 rapid edits before Save: 0 serialization operations, 0 writes.
- Explicit first meaningful save: one 73,250,953-byte comments serialization; one comments target write; 13 total bounded LKG/temp/install writes; maximum active writes 1.
- Total first-generation write traffic was 220,398,747 bytes because legacy current bytes were preserved as LKG, prepared, and installed. This does not repeat for no-op operations.

## 24. Future-history growth measurements

One hundred representative concise history transitions serialized to 74,492 bytes, averaging 745 bytes each. Growth is approximately linear and contains no nested context/history. Duplicate and immediate reverse ping-pong transitions were prevented.

## 25. Failure-injection results

- LKG write failure: previous current generation remains valid; no recovery prompt needed.
- Temporary write failure: previous current generation remains valid; no recovery prompt needed.
- Document install failure before any later file install: previous committed set remains valid; no recovery prompt needed.
- Comments, patches, manifest, or commit install failure after partial data installation: old commit remains authoritative and startup offers recovery.
- Truncated JSON: preserved; LKG recovery succeeds.
- Stale temporary files: detected and removed.
- Delayed stale save: superseded; newest state wins.

## 26. Production build/start commands and port

- Build: `npm run build`
- Dedicated server: `npm run start -- --port 3117 --hostname 127.0.0.1`
- Browser audit: `PATCHMARK_EDITOR_URL=http://127.0.0.1:3117/ PATCHMARK_RAPID_EDIT_COUNT=100 npm run test:persistence-browser-audit`
- Recovery audit adds `PATCHMARK_RECOVERY_BROWSER=1` and uses the compact failure-injection fixture.

## 27. Fixture paths

- Current browser audits create deterministic fixture copies under task-owned
  temporary roots and remove them after each run.
- Recovery and patch-continuation browser tests create and remove their own
  isolated deterministic copies.

## 28. Browser validation results

- Full 73 MB copied project: all no-op actions produced zero writes; 100 rapid edits stayed responsive and unpersisted until Save; one complete generation was installed with maximum one active write.
- Partial manifest install: Save reported the injected failure; reload detected the incomplete generation.
- Recovery fixture: recovery banner appeared, restore completed, questionable files were retained, and the banner cleared.
- Malformed JSON fixture: source was preserved and valid LKG JSON restored.
- Patch/comment workflow: patch applied, linked anchor remained on retained text, reply persisted, ChatGPT export/import lineage remained correct, reload preserved state, and resolving the linked comment behaved correctly.

## 29. Residual consistency risks

- File System Access has no portable multi-file transaction, rename primitive, or `fsync`; a crash between target installs is recovered through commit-last validation and LKG rather than prevented atomically.
- Snapshot/import/context sidecar files remain outside the current-state generation. A crash may leave an unreferenced sidecar, but it cannot make the current document/comments/patches generation appear committed.
- The first meaningful save of an uncompressed 73 MB legacy project has high temporary I/O and storage cost.
- Recovery read-only is enforced in editor/actions and again in the persistence coordinator; future UI actions must continue using the coordinator.

## 30. Phase 7C recommendation

Phase 7C should compact only copied fixtures first: retain the current anchor, thread, patch impacts, stable evidence, and a bounded useful history; convert legacy full entries to concise evidence; verify canonical resolution/highlight/Find/rail behavior; compare hashes and semantic inventories; then request explicit approval before touching the live project. Compaction should be one recoverable generation and should report exact before/after bytes.

## 31. Live project unchanged

Before/after SHA-256 values are identical:

- `document.md`: `b820cc3d6d7f55359db8a974038262a73e2995843a1914742f62559266f7286a`
- `comments.json`: `ac176df9e676c60da530d785e32a512d8e52bafd2a5afbad49c2f1adf1340bb7`
- `patches.json`: `12e5a22a3870ce75e376e0b314d7947fe2091b6282372ab9ea5a7d50e5a5c3d3`
- `manifest.json`: `b41d9e48e4b377453f2ff1c506ec7cb5e593582456f2b2caf8cbdd74f21db77d`

## 32. No destructive compaction

No anchor history was removed or rewritten in the live project. Existing oversized legacy history remains readable and unchanged.

## 33. Dedicated server stopped

The production server dedicated to this validation was stopped. Port `3117` has no listener.

## 34. Existing user server untouched

No existing Patchmark development/user server was stopped or restarted. Validation used only the dedicated `127.0.0.1:3117` process.

## 35. Commit status

No commit was created. No files were staged.

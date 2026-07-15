# Patchmark Phase 7C: Safe Legacy Anchor-History Compaction

Date: 2026-07-15 (Asia/Bangkok)

## 1. Git root and branch

- Git root: `/Users/yskoryk/Documents/patchmark`
- Branch: `develop`
- The existing worktree was preserved. No branch, repository, checkout, or worktree switch was performed.

## 2. Prior reports consumed

- `docs/phase-7a-persistence-audit.md`
- `docs/phase-7b-persistence-safety.md`

The implementation reuses Phase 7B's concise history format, generation ordering, temporary-file verification, commit-last metadata, LKG recovery, stale-write protection, and no-op suppression.

## 3. Files changed

- `lib/comments/comment-anchor-history.ts`
- `lib/comments/comment-history-compaction.ts`
- `lib/project/patchmark-project.ts`
- `scripts/lib/node-directory-handle.mjs`
- `scripts/lib/comment-history-compaction-maintenance.mjs`
- `scripts/compact-comment-history.mjs`
- `scripts/comment-history-compaction.test.mjs`
- `scripts/compact-comment-history-cli.test.mjs`
- `scripts/comment-rail-editor-browser-regression.test.mjs`
- `package.json`
- `docs/phase-7c-history-compaction.md`

## 4. Maintenance command and arguments

Dry-run is the default and requires an explicit project path:

```bash
npm run compact:comment-history -- \
  --project /path/to/project \
  --dry-run \
  --report /outside/source/report.json
```

Apply is explicit and can be tied to a separately reviewed dry-run fingerprint:

```bash
npm run compact:comment-history -- \
  --project /path/to/copied/project \
  --apply \
  --expected-source-hash SHA256
```

Rollback is explicit:

```bash
npm run compact:comment-history -- \
  --project /path/to/project \
  --restore-backup /path/to/history-compaction-backup
```

The command prints the exact project path and mode. It never infers the currently open project and never runs on project load or ordinary Save.

## 5. Dry-run output

The CLI prints a short human-readable summary followed by a `PATCHMARK_COMPACTION_JSON` machine-readable document. Optional `--report` writes that JSON atomically to the caller's chosen location. The report contains the project fingerprint, file descriptors, history/rule counts, projected bytes, per-comment hashes/counts, warnings, blocking errors, and timing evidence. It never prints complete private comments or document contents.

## 6. Legacy conversion rules

- Only legacy v1/full-anchor history is eligible.
- Existing concise `format_version: 2` entries are preserved byte-semantically and are not re-compacted.
- Legacy transitions reuse the Phase 7B concise schema and stable IDs.
- Conversion retains timestamp, cause, source IDs, source patch, mutation generation, previous/next range and state, bounded excerpt/hash evidence, heading/path, impact, method, confidence, and document hashes when available.
- Full anchor context, complete selected sections, runtime candidates, layout data, and nested objects are not copied.
- Per-comment canonical resolution is compared before/after. If conversion would change state, cardinality, range, or structural target, that comment's legacy history is conservatively retained and a warning is reported.

## 7. Recursive flattening

The engine recursively audits history entries for nested `anchor_history`, recovery arrays, complete comment objects, and complete patch objects. Eligible legacy entries are projected once into concise evidence, which removes the nested subtree. The report records affected entries, maximum depth, bytes before, and bytes after. The real fixture contained zero recursive entries; synthetic recursive fixtures passed and emitted no nested history in output.

## 8. Duplicate and no-effect removal

- Semantic duplicate identity includes comment ID, previous/next concise state, cause, reason, source IDs/patch, mutation generation, impact, and document hashes.
- Existing concise semantic keys are preloaded so an equivalent legacy entry is removed while the concise entry remains unchanged.
- The first trustworthy legacy transition in source order is retained deterministically.
- A transition with no next state, or identical effective previous/next state, is removed unless it represents a real state change such as `needs_review`.
- Real fixture: 4,602 duplicate transitions and 7 no-effect transitions removed.

## 9. Recovery ping-pong

Only adjacent reverse legacy recovery transitions are candidates. They must share source patch, source ID, and mutation generation; both must be canonical/historical recovery; and the current active anchor must disambiguate which direction remains truthful. Human re-anchor, distinct patch, distinct mutation, ambiguity/deletion, and concise v2 boundaries are never crossed. Real fixture: 2 ping-pong sequences / 2 entries suppressed.

## 10. Editing-session coalescing

Coalescing requires legacy evidence explicitly identifying the same `manual_edit` mutation generation and source ID, continuous active-state transitions, no source patch, and no intervening workflow boundary. The first previous state and final next state are retained. Real legacy data did not carry safe editing-session identity, so zero real entries were coalesced. Synthetic continuous-session coverage passed; concise v2 entries are never coalesced.

## 11. Patch-impact behavior

Patch records are not changed. Comment patch impacts are deduplicated only when every semantic field except `impacted_at` is equal, including any future range/generation fields present on the record. The earliest source-order impact remains. Real fixture: 5,166 impacts reduced by 4,617 exact semantic duplicates to 549 unique impacts.

## 12. Thread preservation

All 233 thread entries were preserved: 4 user, 36 ChatGPT, and 193 system entries. IDs, timestamps, contents, edit history, sources, URLs, import IDs, and patch IDs remain unchanged. The dry-run audits exact duplicate technical messages but the first apply implementation deletes none. Real fixture reported zero exact technical-thread duplicates.

## 13. Current-anchor preservation

The current `comment.anchor` object is copied unchanged and remains authoritative. The engine hashes it before/after and validates protected comment fields. Canonical state, cardinality, range, and structural context were equal for all 31 real comments; there were zero canonical-equivalence warnings and zero blocking errors.

## 14. Backup format and location

Apply creates:

```text
.patchmark/backups/history-compaction-<timestamp>-pre_compaction/
  backup-manifest.json
  files/document.md
  files/.patchmark/comments.json
  files/.patchmark/patches.json
  files/.patchmark/manifest.json
  files/.patchmark/save-commit.json          # when present
  files/.patchmark/recovery/...              # when present
```

The manifest records format, reason, source path/fingerprint, and SHA-256/byte size for every file. Files use exclusive copy, are verified before the manifest is atomically installed, and existing backups are never overwritten or deleted automatically.

## 15. Apply preconditions

Apply requires a valid explicit Patchmark directory, parseable JSON, a writable current generation, no recovery/read-only state, unchanged source fingerprint, sufficient free space for backup/LKG/temp/current reserves, writable backup destination, a successful in-memory compaction, no blocking invariant errors, and a non-zero eligible reduction. `--expected-source-hash` detects changes after a separately reviewed dry run.

## 16. Atomic apply

Compacted comments are generated entirely in memory. The source fingerprint is rechecked before backup and again before commit. `saveProjectState` then creates one Phase 7B generation: current state becomes LKG, unique temp files are written/read/hash-verified, comments are installed, manifest is installed, and `save-commit.json` is installed last. Fixture B created generation 1 and changed only comments plus required manifest/commit metadata.

## 17. Post-apply validation

The command reloads through `openProjectFolder`, verifies the active committed generation, comment/thread/anchor/patch semantics, reruns compaction for idempotence, and performs a no-op Save. Fixture B post-validation reported zero serialization, zero writes, and zero bytes written. A validation failure triggers automatic generation-ordered restore from the verified backup and retains a safety backup of the failed compact state.

## 18. Rollback

Rollback verifies every backup file, creates a pre-restore safety backup of the compacted current state, and restores document/comments/patches/original meaningful manifest through `saveProjectState`. It then reloads normally and validates document/comments/patches against backup hashes or semantic JSON equality. It never deletes the compacted safety copy. Fixture C restored through generation 2.

## 19. Idempotence

The second dry-run on compacted Fixture B reported zero legacy entries and zero estimated reduction. A second apply is refused as unnecessary. One new concise transition was later added; a semantically identical replay returned the same history array, added zero records, and a no-op Save performed zero serialization and writes.

## 20. Fixture paths and hashes

Root: `/private/tmp/patchmark-phase7c-20260715-142252`

- Fixture A: `/private/tmp/patchmark-phase7c-20260715-142252/fixture-a-dry-run`
- Fixture B: `/private/tmp/patchmark-phase7c-20260715-142252/fixture-b-apply`
- Fixture C: `/private/tmp/patchmark-phase7c-20260715-142252/fixture-c-rollback`
- Original project fingerprint on all untouched copies: `98b86b46c6f909e98816f86b956e842de248704fa23d94ecc5e08fdf8b6e8761`
- Fixture B generation-1 fingerprint: `b82521535dfd714677c496965c60955b03e6e96690f9e0b6ebfd0af4a597ccc4`
- Fixture C document/comments/patches hashes after rollback exactly matched its pre-compaction hashes.

## 21. Before/after sizes

| Metric | Before | After compaction | Reduction |
| --- | ---: | ---: | ---: |
| Pretty/raw comments JSON | 73,421,300 B | 1,583,008 B | 97.84% |
| Compact JSON | 68,331,873 B | 1,209,507 B after one validation transition | 98.23% |
| Gzip | 6,871,051 B | 112,499 B after one validation transition | 98.36% |
| History entries | 5,381 legacy | 770 concise immediately after compaction | 85.69% count reduction |

After the explicit Phase 7B compatibility transition, Fixture B contains 771 concise entries and zero legacy entries.

## 22. Reduction

The dry-run projected and apply produced a 97.84% pretty-file reduction. This is substantial and consistent with Phase 7A's finding that legacy anchor history dominated the file. Thirty comments changed only in compactable history/impact fields; one comment was unchanged.

## 23. Performance

Median measurements from the existing persistence size audit:

| Operation | Before | After |
| --- | ---: | ---: |
| JSON parse | 108.36 ms | 2.17 ms |
| Pretty stringify | 222.23 ms | 3.03 ms |
| Filesystem write | 1,222.25 ms | 2.05 ms |
| Total pretty-save benchmark | 3,687.28 ms | 6.93 ms |
| Normal project load in CLI analysis | 818.26 ms | 24.58 ms |
| Canonical validation + compaction analysis | 1,475.81 ms | 71.83 ms |

The production browser loaded compacted Fixture B in 296.29 ms. Its explicit 100-edit save serialized 1,412,661 bytes with a 2.9 ms stringify median and maximum one active write.

## 24. Dry-run no-mutation proof

Fixture A's document/comments/patches/manifest SHA-256 inventory was recorded before and after dry-run and `diff` was empty. Focused CLI tests repeat the same proof. Dry-run creates no backup, no temp save, no generation, and no project write.

## 25. Canonical-resolution equivalence

All 31 real comments preserved canonical state, cardinality, range, and structural context. There were zero warnings from the canonical-equivalence guard. Current anchors and protected fields were unchanged.

## 26. Historical convergence

The linked accepted-patch replacement, table-cell replacement, section-heading rename, stale historical-anchor replay, Markdown/plain matching, multi-block replacement, ping-pong prevention, and duplicate-short-text regression suite passed after implementation. Mixed legacy/concise coverage and conservative canonical fallback also passed.

## 27. Full visual audit

The Phase 5 browser harness gained an audit-only mode that waits for MDXEditor projection instead of relying on obsolete comment IDs. Against compacted Fixture B it reported:

- total comments / rendered rail rows: 31
- selected-text comments: 25
- uniquely resolved selected-text comments: 25
- canonical projection passes: 25
- visible highlight passes: 25
- exact Markdown Find-selection passes: 25
- rail-position passes: 25
- switch back to Visual Mode / same target passes: 25
- failures: 0
- unexpectedly unresolved linked replacements: 0

Section and document comments were not classified as selected-text failures.

## 28. Phase 7B compatibility

- Concise-history append/dedup tests passed.
- One real concise transition was added to compacted Fixture B at generation 2.
- Duplicate replay added zero entries.
- No-op Save after the transition: zero serialization and zero writes.
- Production no-op interactions (activation, Find, scroll, patch review, PDF preview, Save, mode switch, rerender, reload): zero writes.
- 100 rapid edits: 100 performance records, zero pre-save writes, one bounded explicit-save generation, maximum one active write.
- Partial-save injection remained detectable and recoverable.

## 29. Failure injection

Focused CLI tests cover:

- backup creation failure: abort, current files unchanged;
- serialization failure after backup: source unchanged, verified backup retained;
- temporary write failure: active generation unchanged;
- manifest rename/install failure on a committed fixture: commit metadata not advanced, reload reports inconsistent current state and offers LKG recovery;
- post-apply validation failure: automatic rollback through a new generation, failed compact state retained in safety backup;
- interrupted rollback write: last complete compact generation remains loadable;
- source change after dry-run: apply rejected by fingerprint mismatch;
- legacy project without Phase 7B metadata: safe generation-0 baseline, compaction commits generation 1.

## 30. Production commands and port

An isolated source copy was built at `/private/tmp/patchmark-phase7c-20260715-142252/production-source` with the repository's `node_modules` linked read-only for dependency reuse.

```bash
npm run build
npm run start -- --port 3117 --hostname 127.0.0.1
```

Browser commands used `PATCHMARK_EDITOR_URL=http://127.0.0.1:3117/` and compacted Fixture B.

## 31. Production browser results

The production editor opened compacted Fixture B, projected all 31 comments, passed all 25 eligible selected-text highlight/Find/rail checks, reloaded without growth, and passed the persistence browser audit. Representative paragraph, table/link, linked replacement, and multi-block anchors are included in the all-comment run. Patch review and PDF preview were also no-write actions.

## 32. Backup restore

Fixture C compacted at generation 1, created a verified pre-compaction backup, created a verified pre-restore safety backup, and restored at generation 2. `document.md`, `comments.json`, and `patches.json` SHA-256 hashes exactly matched the original copied fixture afterward. The restored project loaded normally.

## 33. Intentionally retained historical data

- 770 concise transitions immediately after compaction;
- one additional real compatibility transition added afterward;
- all 549 unique patch impacts;
- all 233 thread entries;
- current anchors and contexts;
- all patch records and accepted/rejected/stale states;
- backup packages and safety copies;
- any future legacy history whose removal would fail canonical-equivalence validation.

## 34. Risks

- Backups intentionally retain the large original file and require substantial disk space.
- Browser File System Access still lacks a portable multi-file rename transaction; Phase 7B commit-last/LKG recovery remains the safety boundary.
- Very old noncanonical JSON may be normalized by generation-ordered restore; the rollback verifier therefore requires exact document equality and exact-or-semantic JSON equality, while normal Patchmark-produced files restore byte-identically.
- Editing-session coalescing is intentionally conservative and yields no savings without trustworthy session/generation metadata.
- Technical system-thread cleanup remains deferred.

## 35. Future maintenance UI

A future explicit Project Maintenance screen could show metadata size, eligible legacy count, projected savings, source fingerprint, backup destination, and a reviewed Compact action. It should invoke the proven dry-run/apply workflow and must never run automatically.

## 36. Live project preservation

The live project `/Users/yskoryk/Documents/patchmark_docs/action_plan_market_growthb` was read only for source hashes and copied fixtures. Its final hashes remain:

- document: `b820cc3d6d7f55359db8a974038262a73e2995843a1914742f62559266f7286a`
- comments: `ac176df9e676c60da530d785e32a512d8e52bafd2a5afbad49c2f1adf1340bb7`
- patches: `12e5a22a3870ce75e376e0b314d7947fe2091b6282372ab9ea5a7d50e5a5c3d3`
- manifest: `b41d9e48e4b377453f2ff1c506ec7cb5e593582456f2b2caf8cbdd74f21db77d`

## 37. No live compaction

No dry-run apply, backup, save generation, rollback, or compaction was run against the live project. All write tests used `/private/tmp` copies.

## 38. Dedicated server stopped

The dedicated production server on `127.0.0.1:3117` was stopped after validation. A connection check failed as expected and no listener remained.

## 39. Existing user server preserved

The existing Patchmark server on port 3000 remained running throughout. The production build used an isolated source copy and did not modify the current worktree's `.next` directory.

## 40. Commit status

No commit was created. No files were staged. Phase 7C changes remain as intentional uncommitted work for review.

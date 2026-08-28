# HC-3 dependency and advisory disposition after Slice 7A

Inventory date: 2026-08-27

Slice 7A baseline: `1f4b3049717b4e9faf55a1a2c9541a9e284df58a`

Node: `v22.22.2`

npm: `10.9.7`

Decision: the MDXEditor/js-yaml and Next/PostCSS advisory blockers recorded by
Slice 6 are closed by qualified dependency-family migrations

## Historical Slice 6 state

At Slice 6, `package-lock.json` had SHA-256
`a6cc35de34daf7dafe07f1575e80470a3efdf5a44e76bbdf30bc73185bd00095`.
Both the full and `--omit=dev` audits reported four vulnerable package
records: two moderate, two high, zero critical. The exact vulnerable paths
were Patchmark -> `@mdxeditor/editor@3.55.0` -> `js-yaml@4.1.1` and Patchmark ->
`next@15.5.24` -> `postcss@8.4.31`. Slice 6 correctly left both as release
blockers instead of using an override, suppression, forced audit repair or
unqualified major update.

## Slice 7A family A: editor, Lexical, and js-yaml

Slice 7A migrated the coherent family to exactly:

- `@mdxeditor/editor@4.2.2`;
- the direct `lexical@0.48.0` command provider and one 0.48 Lexical family;
- `js-yaml@4.3.1` through MDXEditor and the deduplicated development path.

The package graph contains no Sandpack package and no second Lexical family.
React and React DOM remain at the previously resolved `19.2.7`; this migration
did not require a React-family change.

This closes all three js-yaml records:

| Advisory | Prior severity and risk | Qualified closure |
| --- | --- | --- |
| [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | moderate; repeated merge aliases could consume quadratic CPU | `js-yaml@4.3.1`, plus bounded hostile-frontmatter tests |
| [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | high; chained merge mappings could consume quadratic CPU | `js-yaml@4.3.1`, including an over-budget merge-chain rejection |
| [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | high; ordered maps could consume quadratic CPU | `js-yaml@4.3.1`, including a bounded ordered-map corpus case |

The production-reachable frontmatter path was not treated as a version-number
exercise. A frozen, test-only corpus covers ordinary and empty frontmatter,
malformed and duplicate keys, anchors and merge keys, safe and unsafe tags,
prototype-shaped keys, depth, large scalars, repeated aliases, merge chains,
ordered maps, invalid UTF-8, fenced delimiters, rich Markdown, long documents,
unsupported JSX, a real edit, reset, and reopen. The descriptor/corpus is test
infrastructure only and is not a protocol object or accepted production input.

MDXEditor 4 changed the editable-area translation path and exposes malformed
frontmatter as a synchronous render exception. Patchmark now supplies a
complete default-preserving translation override for the custom accessible
label and contains render-time parser failures in the existing Markdown-safe
fallback. It does not add a parser, change project bytes, or convert malformed
source. Normal open is source-authoritative and produces no edit. Focused
Chrome qualification passed all 15 corpus cases, including exact source
restore after the one intentional edit.

## Slice 7A family B: Next, PostCSS, and lint/build peers

Only after family A passed independently, Slice 7A migrated exactly:

- `next@16.3.3`;
- Next's `postcss@8.5.23` dependency;
- `eslint-config-next@16.3.3` and its supported flat configuration.

This closes all four recorded PostCSS advisories:

| Advisory | Prior severity and risk | Qualified closure |
| --- | --- | --- |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | moderate; unsafe CSS stringify | `postcss@8.5.23` |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | high; source-map local-file disclosure | `postcss@8.5.23` |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | moderate; incomplete source-map fix | `postcss@8.5.23` |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | high; source-map traversal | `postcss@8.5.23` |

Next 16 defaults to Turbopack and rejects a build that also supplies custom
Webpack configuration. Patchmark deliberately retains Webpack via explicit
`next dev --webpack` and `next build --webpack` commands. The custom Webpack
path is part of the strict production CSP/Trusted Types qualification, disables
production development tooling, and is also used by the optimized
real-authority harness and complete deployable-chunk scan. Using one qualified
bundler topology for development security tests, production, and the optimized
harness avoids claiming evidence for different output graphs. This is a
documented project-specific opt-out supported by the Next 16 upgrade guide.

Next 16's generated route types require the two generated imports in
`next-env.d.ts`, `react-jsx`, and `.next/dev/types` in `tsconfig.json`. The lint
configuration now imports the official Next 16 flat presets directly. New
React Compiler-oriented `react-hooks/refs` and
`react-hooks/set-state-in-effect` rules are explicitly held outside the
accepted lint contract: applying them would require behavior-sensitive changes
across 37 existing components and is not a dependency-family migration. The
established hooks, TypeScript, Next and accessibility checks remain active.

The optimized build adapter now loads the Next SWC bindings before invoking
the bundled loader, matching Next 16's internal loader contract. Production
build, normal-production CSP/Trusted Types and the test-only optimized
real-authority qualification all pass. The normal production run reports 17
security assertions, zero policy violations and only the reviewed `default`
and `nextjs#bundler` policies. The optimized two-profile run reports 52
assertions, exact durable authority equality after reopen, zero violations and
the private `patchmark#optimized-bundler` policy.

The normal `nextjs#bundler` validator requires the candidate script URL's exact
current page origin, including scheme and effective port. HTTPS is required
except when that same current origin uses HTTP with canonical hostname
`localhost`, `127.0.0.1`, or `[::1]`; a deployed non-loopback page cannot
authorize any loopback script URL. URL parsing and normalization precede the
`/_next/static/chunks/*.js` path predicate. Different origins, schemes,
non-default ports, subdomains, suffix-confusion hosts, credentials, queries,
fragments, encoded separators, escaping traversal, `blob:`, `data:`, and
`javascript:` inputs reject. Normal qualification omits `strict-dynamic`, so
CSP and Trusted Types remain cumulative defenses.

That policy is currently enforced by the production-mode qualification proxy
around the real `next start` build and Webpack runtime; it proves compatibility
but is not a deployed serving-boundary header/bootstrap. Installing and
requalifying the same constraints in the chosen deployment architecture is a
future production-enablement prerequisite, not a current localhost security
defect. The optimized harness's separate exact-origin, content-hashed
`patchmark#optimized-bundler` policy uses `strict-dynamic` only in test output
and remains absent from deployable production graphs.

## Performance comparison

The directional investigation reproduced the approximately `785.61 ms`
stress direction as a fresh code-and-table-heavy Visual-editor construction
after a Markdown target. MDXEditor 4's initial import and a redundant
same-source `setMarkdown` application doubled heavy decorators, observers and
listeners. The readiness gate now waits for that exact initial import, deferred
heavy editors share one observer, and comment projection waits for the target
transaction. Across 60 samples per direction, optimized warm medians/p95 are
`277.8/365.9 ms` and `331.6/417.2 ms` against baseline `280.1/385.6 ms` and
`332.9/412.0 ms`. The affected stress median fell from `819.8 ms` unoptimized
to `522.4 ms`; equal-complexity controls remove directional asymmetry. Exact
methodology, fixture identity, phases, resources and distributions are bound
in `document-switch-performance-slice7a.json` and the Slice 7A migration
record. Atomicity, semantic readiness and document authority remain intact,
but the remaining matched stress gap keeps Slice 7A performance acceptance
open and is not waived by the dependency-family closure.

## Final inventory and decision

The final lockfile SHA-256 is
`2609200fc64d096a9fa574bb7f6043ca5b35cb261d4b8c8b4c4e07d76784655c`.
The installed graph has 639 npm dependency records plus the root record, one
Lexical version (`0.48.0`), and no Sandpack package. Fresh full and
`--omit=dev` audits both report zero vulnerable package records. QR remains
exactly `0.6.0` with the same reviewed tarball integrity and source bytes.

The former `HC3-S6-JS-YAML` and `HC3-S6-POSTCSS` rows therefore become
non-blocking passes. This closes only those two dependency blockers. Slice 7A
does not approve a production browser floor, privacy language, external or
physical-device evidence, human accessibility review, independent security
review, support ownership, or production enablement. Collaboration remains
disabled and unreachable; those deliberately missing decisions remain for
Slice 7B or a later authorized gate change.

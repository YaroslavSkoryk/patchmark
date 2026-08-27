# HC-3 Slice 6 dependency and advisory disposition

Inventory date: 2026-08-27
Baseline: `96aea97e939b8f7e5e21a1fcb3d30131a9e008eb`
Node: `v22.22.2`
npm: `10.9.7`
Decision: unresolved production audit records remain release blockers

## Inventory method

`package-lock.json` is the exact direct and transitive package inventory. Its
Slice 6 starting SHA-256 is
`a6cc35de34daf7dafe07f1575e80470a3efdf5a44e76bbdf30bc73185bd00095`.
`npm ls @mdxeditor/editor js-yaml next postcss qr --all` confirmed these paths:

- production editor: Patchmark → `@mdxeditor/editor@3.55.0` →
  `js-yaml@4.1.1`;
- production framework/build: Patchmark → `next@15.5.24` →
  `postcss@8.4.31`;
- production collaboration QR: Patchmark → `qr@0.6.0`, with zero runtime
  dependencies;
- development lint: Patchmark → `eslint@9.39.4` →
  `@eslint/eslintrc@3.3.5` → deduplicated `js-yaml@4.1.1`.

Both `npm audit --json` and `npm audit --omit=dev --json` reported four
vulnerable package records: two moderate, two high, zero critical. Both scans
covered 627 records (292 production, 295 development, 65 optional and 3 peer
records as npm categorizes the graph). Production omission does not remove the
four records.

## MDXEditor and js-yaml

| Advisory | Severity | Affected | Patched | Reachability |
| --- | --- | --- | --- | --- |
| [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | moderate | js-yaml 4.0.0–4.1.1 | 4.2.0 | Repeated merge aliases can consume quadratic CPU. |
| [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | high | js-yaml 4.0.0–4.2.x | 4.3.0 | Chained merge mappings can consume quadratic CPU. |
| [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | high | js-yaml 4.0.0–4.3.0 | 4.3.1 | Default-schema ordered maps can consume quadratic CPU. |

The vulnerable function is production-browser reachable. Patchmark imports
MDXEditor's `frontmatterPlugin()` in both editable and read-only Markdown
surfaces. A user opening an untrusted Markdown project can therefore cause its
frontmatter to reach js-yaml. Collaboration adds no special parser, but an
untrusted document received through collaboration is still project Markdown
and can reach the same editor path after acceptance. This is an availability
risk in the browser renderer, not a server or build-only finding.

Registry evidence shows no patched MDXEditor 3.x release. npm offers
`@mdxeditor/editor@4.2.2`, which depends on `js-yaml@4.3.1` and Lexical 0.48
packages. The [MDXEditor 4.0 release](https://github.com/mdx-editor/editor/releases/tag/v4.0.0)
removes Sandpack APIs Patchmark does not use, but Patchmark directly imports
`CLEAR_HISTORY_COMMAND` from separately pinned `lexical@0.35.0`. Updating only
MDXEditor would install two Lexical families and risks passing a command symbol
from 0.35 to an editor built on 0.48. A safe migration therefore includes the
affected editor/Lexical family and requires the complete editor behavior,
selection, comments, patches, bookmarks, switching, serialization, CSP and
Trusted Types regression set. That is larger than a semantically safe
single-package repair in this evidence-closure slice.

No migration was applied. No override, resolution, fork, vendored patch,
audit suppression or forced repair was added. Required disposition before an
enablement change: complete the editor-family migration or obtain explicit
security and product risk acceptance. Until then this path is a release
blocker.

## Next and PostCSS

| Advisory | Severity | Affected | Patched | Reachability |
| --- | --- | --- | --- | --- |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | moderate | PostCSS before 8.5.10 | 8.5.10 | Unsafe CSS stringify only when attacker CSS is embedded as HTML. |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | high | PostCSS through 8.5.11 | 8.5.12 | Attacker-controlled source-map annotation can read local files. |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | moderate | PostCSS through 8.5.22 | 8.5.23 | The source-map fix is incomplete when `from` is absent. |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | high | PostCSS through 8.5.17 | 8.5.18 | Traversal can disclose reachable `.map` files. |

Patchmark does not accept user CSS, PostCSS plugins, source maps or build
configuration. Imported Markdown and collaboration artifacts are rendered as
document content and never enter the CSS build. The vulnerable PostCSS
functions are reachable only in the trusted local production build pipeline
over repository-controlled CSS. The XSS preconditions and attacker-controlled
`sourceMappingURL` preconditions are absent from normal Patchmark use.
Compensating controls are trusted build inputs, no user CSS, no remote build
plugins, lockfile integrity, CSP, and review of repository CSS changes. These
controls reduce exploitability; they do not clear the npm finding.

Next 15.5.24 pins PostCSS 8.4.31. npm reports no compatible Next 15 repair and
offers `next@16.3.3`, which carries `postcss@8.5.23`. The official
[Next 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
documents a default Turbopack build, async request API removal, routing and
prefetch changes, config changes, removals and a codemod. Patchmark has a
security-sensitive custom Webpack path for its optimized CSP/Trusted Types
qualification and production chunk scans. A framework-major migration must
requalify build topology, the production gate, all deployable chunks, CSP,
Trusted Types, editor hydration and representative single-user behavior.

No migration was applied. The build-only reachability makes this lower risk
than the editor path, but it remains a release blocker until a reviewed Next
16 migration, an upstream backport, or explicit security risk acceptance.

## Decision

The smallest compatible update was already exhausted in Slice 5. Fresh
registry evidence proves both remaining fixes cross a major dependency family.
Slice 6 preserves package-manager integrity and makes no dependency or lockfile
change. Production collaboration remains disabled. The final audit result is
expected to remain two moderate and two high vulnerable package records; a
clean audit must not be claimed.

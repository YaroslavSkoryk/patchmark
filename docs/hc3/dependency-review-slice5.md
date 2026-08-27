# HC-3 Slice 5 dependency and advisory review

Audit date: 2026-08-27

## Security-only lockfile update

The starting audit contained seven vulnerable package records: one moderate,
six high. `npm audit fix --ignore-scripts` applied only compatible versions:

- Next 15.5.20 to 15.5.24, with `@next/env` and local SWC aligned;
- Sharp 0.34.5 to 0.35.4 and its platform packages;
- nanoid 3.3.15 to 3.3.18;
- brace-expansion 1.1.15 to 1.1.18 and 5.0.7 to 5.0.9;
- supporting optional runtime metadata packages.

No lifecycle scripts ran. The direct version ranges in `package.json` did not
change. No collaboration, cryptography, canonicalization, carrier, QR, or
authority dependency changed. The production build and complete regression
set are required evidence for accepting the lockfile delta.

The final audit contains four vulnerable package records: two moderate and two
high. The compatible pass removed the direct Next server-action/rewrites/cache
findings, Sharp/libvips, nanoid, and both brace-expansion paths.

## Residual findings and reachability

| Package and path | Installed | Severity | Surface and disposition |
| --- | ---: | --- | --- |
| `@mdxeditor/editor → js-yaml` | 3.55.0 → 4.1.1 | direct moderate / transitive high | Production browser code can parse frontmatter from a locally opened Markdown project. Hostile YAML alias/omap input can consume excessive CPU. This is not introduced by collaboration, but it is product-reachable. The npm fix requires MDXEditor 4.2.2, a major upgrade. Keep as a release blocker for a separate editor migration and full editor regression. |
| `next → postcss` | 15.5.24 → 8.4.31 | direct-effect moderate / transitive high | PostCSS is used to build repository-controlled CSS. Patchmark does not accept user CSS or source maps, so the file-read/stringify advisories are build-time rather than a collaboration artifact surface. npm offers only Next 16.3.3, a major framework upgrade. Keep blocked pending a separately reviewed Next migration or upstream backport; use trusted builds and repository-controlled CSS as the compensating control. |

No `use server`, custom Next server, rewrites, `next/image`, or image optimizer
call site was found in application source. That reduced reachability for the
starting Next and Sharp advisories but did not justify leaving compatible
patches unapplied.

## `qr@0.6.0`

`qr` remains an exact direct dependency and is the only dependency introduced
by HC-3. The lock record resolves the registry tarball with integrity
`sha512-P23VoX7SipHALdiIYG+D+LT/6n22dNKwV92FAb3d+Nlki/5WisSsfLt0UDFz2XEBtuwrECTznvu+chKKFCSYhA==`.
The installed tree is 552 KiB on disk and contains JavaScript, declarations,
source, maps, README, and MIT/Apache-2.0 license files. Runtime dependencies,
native binaries, and install lifecycle scripts are absent.

The root import SHA-256 is
`608e9a015454a99f8e08026b273b73a34acb25373ca3572431799647ff7dff6f`;
the decoder is
`89127c12e70e446eea634c88f3e90d719b9f15ac56def386a8809e24e9f2ee61`;
the installed package manifest is
`8f29b45e956c9f272b58d6f63604e5452c3f36581384f63f2b15f0f44b2c5625`.

The package is owned and published by Paul Miller from
`https://github.com/paulmillr/qr`. The 0.6.0 GitHub release is signed and maps
to commit `260ea46`; npm lists zero runtime dependencies and the same MIT or
Apache-2.0 license. Release 0.6.0 was published 2026-04-28 after a documented
self-audit. The repository and package have a single principal maintainer,
which is a continuity risk even though present activity is strong.

Source and published-JavaScript scans found no runtime fetch, XHR, WebSocket,
EventSource, child process, dynamic evaluation, native binding, or lifecycle
network action. URLs in source are documentation, license, namespaces, or
comments. The package includes SVG/string helpers, but Patchmark imports only
the raw encoder and decoder and converts their structured matrix/pixels through
Canvas. Patchmark does not import `qr/dom.js`, call its SVG/string output, or
insert package output as HTML.

The published package manifest and repository metadata/source are consistent
for name, version, exports, license, author, and zero-dependency design. This
review did not reproducibly rebuild the npm tarball from the signed commit, so
byte-for-byte source-to-package provenance remains conditional. The live npm
audit reports no advisory for `qr@0.6.0`.

## Maintenance decision

Keep the pinned dependency for development qualification. Before production,
repeat integrity/advisory/source review, independently reproduce the package
or vendor the narrowly used raw encoder/decoder under the existing license,
and define an owner for security updates. Vendoring would improve continuity
but also transfers patch monitoring and audit responsibility to Patchmark; it
is not automatically safer and is not part of Slice 5.

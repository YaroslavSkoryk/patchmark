# HC-3 Slice 6 QR dependency disposition

Disposition: `accept_pinned_dependency`
Package: `qr@0.6.0`
Review date: 2026-08-27

## Published package and source provenance

The direct package remains exactly pinned. The lock resolves
`https://registry.npmjs.org/qr/-/qr-0.6.0.tgz` with integrity
`sha512-P23VoX7SipHALdiIYG+D+LT/6n22dNKwV92FAb3d+Nlki/5WisSsfLt0UDFz2XEBtuwrECTznvu+chKKFCSYhA==`.
The published tarball is 129,506 bytes, has SHA-1
`00c3d080dc76adf5d3754d9ad7ff0f9263dee2e0`, and unpacks to 520,808 bytes in
19 files. It contains JavaScript, declarations, source maps, TypeScript source,
README, manifest, MIT and Apache-2.0 license text. There are no bundled
dependencies.

npm metadata records source repository `https://github.com/paulmillr/qr`,
`gitHead` `260ea4689bf8921a8585fe3926ec70f11de70fb6`, one maintainer (Paul
Miller), zero runtime dependencies and license `(MIT OR Apache-2.0)`. Source
tag `0.6.0` points to that exact commit and contains a PGP signature. Local GPG
verification was unavailable, so this review records the signature's presence
and GitHub's signed-release trace rather than claiming a locally verified
identity.

A clean checkout of commit `260ea46` installed its five declared development
packages, ran its ordinary TypeScript build, and repacked it without lifecycle
scripts. All 19 unpacked files were byte-identical to the published npm
package. The `.tgz` byte stream itself differed because npm packaging metadata
and compression were regenerated; therefore this is reproducible unpacked
content, not a claim of byte-identical tarball reproduction.

Release 0.6.0 was authored on 2026-04-28. The project is current but has a
single-maintainer continuity risk. npm reports no QR advisory. Re-review is
required when the version, integrity, maintainer, repository revision, package
contents or advisory database changes.

## Supply-chain and runtime surface

The package has no runtime dependencies, native binaries, install lifecycle
scripts or native bindings. Source scans found no `eval`, dynamic `Function`,
fetch, XHR, WebSocket, EventSource, child process or runtime network access.
Build and test scripts are publisher development commands and do not execute
on Patchmark installation.

Patchmark imports only the root raw encoder and `qr/decode.js`. It does not
import `qr/dom.js` or use the SVG, GIF, ASCII or HTML helpers. The optimized
collaboration build resolves only the imported modules; the separate DOM
export is not reachable from the entry graph. Patchmark converts the returned
matrix and pixels with structured Canvas operations, never package-generated
HTML. The reviewed installed encoder SHA-256 is
`608e9a015454a99f8e08026b273b73a34acb25373ca3572431799647ff7dff6f`;
the decoder is
`89127c12e70e446eea634c88f3e90d719b9f15ac56def386a8809e24e9f2ee61`.

The reviewed QR source modules entering that browser graph are 71,111 bytes
for `index.js` and 58,119 bytes for `decode.js`, or 129,230 source bytes before
bundling. The existing production-optimized qualification build is 1,843,281
bytes of minified JavaScript across its 1,269,058-byte entry and 574,223-byte
lazy asset, plus 4,471 bytes of CSS. Webpack does not emit a per-module
post-minification attribution for this harness, so this review records both
the exact imported source boundary and the exact full browser assets rather
than inventing an isolated minified QR contribution.

Existing HC-3 tests freeze error correction, encoding, mask, border, module
count and matrix SHA-256; decode the exact carrier; reject substituted and
malformed content; accept the 2,953-character boundary; and reject 2,954
characters before encoding. Slice 5 adds hostile QR strings, scanner lifecycle
cleanup and exact Canvas presentation. Those tests remain protocol authority;
this package review does not change HC-3 carriers or fixtures.

## License and decision

Patchmark must preserve the chosen MIT or Apache-2.0 notice in distributed
third-party notices. No vendoring or replacement is justified by age alone.
Pinned integrity, reproducible unpacked contents, zero-dependency design,
narrow imports, deterministic vectors and structured rendering support
`accept_pinned_dependency`. Production candidacy still requires an independent
reviewer to confirm this disposition and a named maintainer for advisory and
continuity monitoring.

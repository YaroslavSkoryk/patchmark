# HC-2 Slice 3 cryptographic provider security review

Status: implementation evidence for an unreachable provider boundary. This document does not approve production key custody, recovery kits, enrollment, epoch delivery, portable bundle orchestration, synchronization, or UI enablement.

## Scope and invariants

Slice 3 implements the frozen Slice 1 provider interfaces with WebCrypto and two reviewed packages. The accepted suite remains SHA-256 identities, Ed25519 signatures, native X25519 recipient keys, RFC 9180 Base mode with DHKEM(X25519, HKDF-SHA-256), HKDF-SHA-256 and AES-256-GCM, plus Argon2id and XChaCha20-Poly1305 for recovery protection.

Provider files live only under `lib/collaboration/hc2/providers/`. Neither the HC-2 barrel nor the production collaboration barrel exports them. No application, component, persistence, transport, synchronization, or UI module imports them. Collaboration remains disabled.

The frozen public envelope includes `encapsulated_key_bytes` in AAD, while RFC 9180 produces `enc` during sender setup. The provider resolves that ordering internally: one sender setup yields the exact `enc` and a private context; an exactly-once synchronous finalizer constructs the strict final header from a copy of that `enc`; the provider verifies branded canonical AAD and exact `enc`/`info` binding; then the context performs one seal and is discarded. No placeholder, second setup, independently supplied receiver AAD, or public/reusable context exists. Higher-level enrollment and portable-bundle orchestration remain deferred without weakening this binding.

## Selected dependencies

| Package | Exact installed version | Registry integrity | License | Installed bytes | Published files |
| --- | ---: | --- | --- | ---: | ---: |
| `@hpke/core` | 1.9.0 | `sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==` | MIT | 232,730 | 143 |
| `@hpke/common` | 1.10.1 | `sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw==` | MIT | 524,771 | 215 |
| `libsodium-wrappers-sumo` | 0.8.4 | `sha512-ql7hcgulKZ3ekfa2DGAogcCKsWU0diA/0nArz1CFzh93WQdb46/Kj18ka/Hifq6uA3Ush34Pc6vU/6HXeRwUkg==` | ISC | 553,777 | 7 |
| `libsodium-sumo` | 0.8.4 | `sha512-TMtHShQfVVsaxDygyapvUC3o7YsPgXa/hRWeIgzyFz6w5k/1hirGptCxp1U7XwW3rCskaTTYKgV10v86UiGgNw==` | ISC | 1,623,551 | 5 |

Only `@hpke/core` and `libsodium-wrappers-sumo` are direct dependencies. The lockfile resolves exactly one `@hpke/common` and one `libsodium-sumo`; no other HPKE, Argon2, XChaCha, NaCl, or libsodium implementation was added. Published manifests contain no lifecycle/install scripts and declare `sideEffects: false`.

### Artifact and source correspondence

The exact npm tarballs were downloaded, unpacked, and compared with their manifests before selection.

- `@hpke/core@1.9.0`: npm shasum `4eced0597787f51fdb53ad515c3d47a3abc9fe3a`, published `gitHead` `f9fbe3d5a6404f516df859e472c078c0d08e8057`, registry modified 2026-03-08, npm registry signature and SLSA provenance attestation present.
- `@hpke/common@1.10.1`: npm shasum `11f205e5ba24d558c1bd4ac671580d95d488af18`, published `gitHead` `d56a674fd9c63e2c8176a6e2d68150707158926c`, registry modified 2026-03-12, npm registry signature and SLSA provenance attestation present.
- `libsodium-wrappers-sumo@0.8.4`: npm shasum `6656a3e7e0551ecce08ddee4bfb501a092eac6fa`, published `gitHead` `2830fcf2ce8cefd3fdc7e1efc9fc1cee1d2d95b7`, registry modified 2026-04-19, registry signature present; the registry response did not expose an npm provenance attestation.
- `libsodium-sumo@0.8.4`: npm shasum `6d4687781fa0ad398af14a7df872d5c27cf8cd31`, the same published `gitHead` `2830fcf2ce8cefd3fdc7e1efc9fc1cee1d2d95b7`, registry modified 2026-04-19, registry signature present; the registry response did not expose an npm provenance attestation.

The libsodium package reports upstream primitive version 1.0.22 at runtime. The sumo wrapper is required because the standard wrapper omits `crypto_pwhash`. It exposes Argon2id and XChaCha20-Poly1305 without adding a second recovery implementation.

Both HPKE packages declare Node 16 or newer; the reviewed runtime uses native WebCrypto and was exercised in Node 22 and Chrome 151. The libsodium packages declare browser entrypoints but no Node engine floor; their ESM artifacts were exercised in the same Node/Chrome environments. Edge and the qualified Chromium 137 floor were not installed locally and receive no inferred compatibility claim.

The HPKE ESM artifacts contain no lifecycle scripts, `eval`, dynamic code constructor, timers, network loader, or caller-visible shared-secret API used by Patchmark. The X25519 KEM accepts a complete externally generated native `CryptoKeyPair`; when Patchmark passes that pair, recipient decapsulation does not need to export the non-extractable private key.

The libsodium wrapper is generated JavaScript over the official libsodium.js sumo artifact. Its Emscripten module contains embedded WASM and dormant generic loader/status branches mentioning `XMLHttpRequest` and `setTimeout`. Patchmark statically serves the reviewed same-origin package, loads it only inside an explicitly created recovery worker, passes no external module URL or status hook, and terminates the worker after one operation. The Chrome harness runs with `connect-src 'none'` to demonstrate the selected path does not require network loading. This generated-runtime surface is a reason to keep recovery isolated and lazy.

No formal audit report specific to these exact npm tarballs was relied upon. libsodium and the HPKE standards have extensive public review, but that is not treated as proof that packaging or integration is correct. Patchmark relies on exact pins, artifact hashes, official vectors, independent verification, misuse-resistant wrappers, import isolation, and recurring advisory review.

The hpke-js repository publishes a [security policy](https://github.com/dajiaji/hpke-js/security/policy) with private reporting instructions, but its supported-version table is stale (it lists 1.6.5 rather than current releases). Neither [libsodium.js](https://github.com/jedisct1/libsodium.js/security/policy) nor the upstream [libsodium repository](https://github.com/jedisct1/libsodium/security/policy) currently exposes a GitHub `SECURITY.md`. These policy gaps are recorded risks and reinforce the requirement for direct advisory monitoring rather than reliance on repository badges.

## Advisory disposition

The historical reusable-context nonce race in hpke-js is [GHSA-73g8-5h73-26h4 / CVE-2025-64767](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4). Versions through 1.7.4 were affected; 1.7.5 introduced the correction. The selected 1.9.0 contains the serialized context operation fix. Patchmark adds a stronger boundary: each operation creates a fresh context, a structural guard permits exactly one `seal` or `open`, and the context is never returned.

The install-time audit found no advisory affecting the four selected cryptographic packages. The repository-wide audit still reported seven pre-existing findings in unrelated application/tooling dependencies (one moderate and six high, including MDX/YAML, brace expansion, Nano ID, and Next/PostCSS/sharp paths). Those findings predate this dependency addition and are not silently attributed to or fixed by Slice 3; they require the repository’s normal dependency-remediation process.

No unresolved critical/high advisory was identified for the selected exact crypto graph during this review. This is time-bound evidence, not a permanent claim. Before any production enablement, CI must monitor npm/GitHub advisories and upstream security policies and block unreviewed version drift.

## Provider boundaries

### Randomness

`WebCryptoRandomSource` uses only `crypto.getRandomValues`. It accepts integer lengths from zero through 16 MiB, splits requests into at most 65,536-byte calls, copies the result, and maps platform failures to secret-free typed errors. It has no deterministic mode or fallback.

### Native keys and signatures

`Hc2NativeKeyRegistry` generates Ed25519 and X25519 through WebCrypto with non-extractable private keys and extractable public keys. WeakMap-backed opaque handles bind the exact native pair and canonical public encoding; private-only, forged, cross-algorithm, wrong-usage, and extractable-private inputs are rejected.

The strict public-key codec uses canonical CBOR over the domain `patchmark/hc2/public-key/v1`, algorithm, branded public-key ID, and exactly 32 raw public bytes. Decode requires canonical re-encoding equality and exact algorithm/usage. There is no private-key codec.

The frozen `PublicKeyCodec` accessors are synchronous even though native WebCrypto import/export is asynchronous. `NativePublicKeyCodec` resolves that mismatch without blocking or raw-key fallback: callers first invoke an explicit asynchronous preparation method, and the frozen synchronous `encode`/`decode` methods subsequently accept only that already-validated native key and exact encoding. Unknown or unprepared inputs fail closed.

Ed25519 signing copies and signs the exact domain-separated preimage supplied by existing builders. Verification requires an `AcceptedSignerPublicKey` resolved from accepted control state; an inline public key cannot manufacture the brand. A successful result binds project, device, key, accepted control head, and SHA-256 of the exact preimage rather than returning a reusable boolean.

### HPKE

`SingleShotHpkeProvider` fixes the suite to RFC 9180 Base mode, X25519/HKDF-SHA-256/HKDF-SHA-256/AES-256-GCM. Its public sender operation is `sealBound({ recipient_public_key, info, plaintext, finalize_aad(enc) })`; its receiver operation is `openBound({ recipient_key_pair, info, public_header, ciphertext_bytes })`. Neither operation exposes an HPKE context or accepts a nonce, alternate suite, shared secret, or independently supplied receiver `enc`/AAD.

Sender execution follows `SetupBaseS → (enc, context) → final header/AAD → one Seal → discard`. The provider strictly validates and copies `info` before setup, passes a copy of the setup-produced 32-byte `enc` to the synchronous finalizer exactly once, accepts only AAD bytes branded by the strict header constructor, re-parses the bytes canonically, checks the final header contains the byte-identical `enc`, and checks every `info` field against that final header. Promise/thenable, throwing, unbranded, malformed, wrong-suite, substituted/missing/duplicated/wrong-length-`enc`, and oversized finalizer results fail before an underlying seal or ciphertext result. The single-use wrapper marks itself consumed and clears its context reference before starting the asynchronous library operation; no failure path retries.

The receiver strictly parses the complete final header, extracts its `enc`, reconstructs AAD solely from that header, validates the fixed `info`, creates one private recipient context, opens once, and discards the context on success or failure. Thus the exact returned `enc` is also the value authenticated inside the complete final header. Per-message header data belongs in AAD because the final header contains setup-produced `enc` and cannot exist before setup; `info` deliberately carries only its deterministic pre-setup binding fields and never a real or placeholder encapsulation.

Malformed framing is distinguished from authenticated rejection only before decryption. Wrong recipient, `enc`, ciphertext, tag, or authenticated inputs collapse to `authentication_failed` at the HPKE boundary.

### Recovery protection

The version-1 record freezes:

- Argon2id version 19;
- operations limit 3;
- memory limit 67,108,864 bytes (64 MiB);
- 32-byte derived key;
- 16-byte random salt;
- provider-managed, non-configurable parallelism (truthfully reflecting the wrapper API);
- XChaCha20-Poly1305 with a 24-byte random nonce and 16-byte tag.

The provider creates one lazy module worker per explicit protect/unlock request. Password and material are copied across the operation boundary. Transferable copies avoid redundant encoded representations. The worker uses `sodium.memzero` for password, material, and derived key in `finally`; caller-side copies are also zeroed. It returns no key, terminates in all completion/error paths, and retains no reusable global recovery key.

Wrong password, wrong person/AAD, corrupted ciphertext, truncation, unknown version, unsupported suite, and parameter downgrade all become the same public `wrong_password` result. Abort remains a typed `operation_aborted` exception; worker creation/runtime failures become `provider_unavailable` without embedded cause text.

Chrome 151 benchmark evidence with the no-network CSP gate enabled for three protect operations at the frozen parameters was 123.4 ms, 124.9 ms, and 129.3 ms (median 124.9 ms, worst 129.3 ms). The post-benchmark observable JavaScript heap was 1,790,148 bytes. That heap metric does not include all WASM/native allocation and must not be presented as peak Argon2 memory; the configured 64 MiB memory cost is the reliable bound. Worker initialization or termination failure fails closed, and no retry, timer, or background loop is implemented.

### Suite negotiation and failures

`ExactHc2SuiteNegotiator` accepts one exact suite identifier only. Missing, partial, duplicate, reordered, unknown, or downgraded input returns `no_exact_supported_suite`. Missing local random, Ed25519, X25519, HPKE, Argon2id, or XChaCha capability throws `unsupported_platform`, distinct from invalid remote input. A frozen selection binds envelope version, HPKE-info domain, public-key codec, and recovery parameter version.

`Hc2CryptoProviderError` exposes a closed code set with fixed secret-free messages: unsupported platform/provider/suite; invalid key/usage/signature/ciphertext/encapsulation/binding; public-key export and private-extractability violations; authentication and recovery-authentication failure; parameter mismatch; abort; and internal invariant failure. Unknown internal exceptions are not copied into diagnostics.

## Vector and interoperability inventory

The frozen fixture is `scripts/fixtures/collaboration-hc2-slice3-v1.json` and contains no large literal payload.

- [RFC 8032 section 7.1 TEST 1](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1), Ed25519.
- [RFC 7748 section 6.1](https://www.rfc-editor.org/rfc/rfc7748.html#section-6.1), X25519 Alice/Bob.
- [RFC 9180 official vector](https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json), exact mode/KEM/KDF/AEAD case. Upstream artifact SHA-256: `61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6` at commit `5f503c564da00b0687b3de75f1dfbdfc4079ad31`.
- [RFC 9106 section 5.3](https://www.rfc-editor.org/rfc/rfc9106.html#section-5.3), Argon2id version 19 with secret, associated data, and four lanes.
- [XChaCha draft appendix A.3.1](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1), XChaCha20-Poly1305.
- A frozen production-parameter recovery case, independently checked against libsodium 1.0.22.
- Existing HC-1 acknowledgement, control-event, semantic-event, and snapshot signature preimages.

The independent Python verifier imports no Patchmark module and no third-party Python package. It implements the RFC X25519 ladder, Ed25519 verification, HChaCha/ChaCha20/Poly1305 formulas, and uses system OpenSSL as a second Argon2id implementation for the complete RFC 9106 case. Node and Chrome match the deterministic RFC 8032 signature byte-for-byte. HPKE deterministic KAT execution uses the official fixed ephemeral IKM; randomized provider tests compare exact bindings, length, context counts, and decryptability rather than claiming ciphertext equality.

## Production enablement gates

Before a user-facing path may import any provider, all of the following remain mandatory:

1. Implement reviewed Slice 4 custody and recovery ceremonies without private-key serialization.
2. Implement Slice 5 enrollment/epoch delivery and consume the bound envelope operation without changing its exact-`enc`/AAD guarantee.
3. Keep exact dependency pins and add continuous advisory/provenance monitoring.
4. Enforce a strict same-origin CSP, including explicit `script-src`, `worker-src`, `connect-src`, and only the minimal WASM execution allowance required by the reviewed artifact.
5. Enforce Trusted Types for relevant DOM sinks and prohibit unapproved third-party scripts.
6. Re-run production client-bundle isolation and startup side-effect tests on every import-graph change.
7. Document that CSP, Trusted Types, and non-extractable keys reduce attack surface but cannot protect secrets from arbitrary same-origin script compromise while keys are actively usable.
8. Complete threat modeling, recovery abuse/rate UX, backup loss, device revocation, and incident response review.

Until those gates pass, the provider boundary remains test-only and unreachable from production.

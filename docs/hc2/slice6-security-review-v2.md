# HC-2 Slice 6 security review

Review target: encrypted transport profile v2, deterministic closure and
chunking, manual file exchange, attachment storage, and stream continuity.

Review result: no known critical or high-severity findings remain in the Slice
6 boundary. Production collaboration remains disabled.

| Threat | Enforced control | Evidence |
| --- | --- | --- |
| Plaintext metadata leakage | Exact nine-field opaque public header; semantic fields exist only in signed ciphertext | Privacy scans and v1/v2 exact-header tests |
| Recipient substitution | Recipient person, membership/candidate state, device, X25519 key, control head, epoch, purpose, and stream are signed | Contract and import binding tests |
| Encryption to revoked or stale authority | Mandatory sender-side resolver verifies accepted sender/recipient state, exact recipient public-key binding, current control head, and local epoch custody before randomness, signing, or HPKE | Pre-crypto export-denial test |
| Sender impersonation | Ed25519 signature is checked against injected accepted-state resolution before import | Real WebCrypto Node/Chrome tests |
| `enc`/AAD mismatch | One HPKE context per container; header finalized from that context's exact 32-byte `enc`; AAD constructed synchronously and seal called once | Provider evidence and deterministic vectors |
| Manifest omission or payload substitution | Manifest commitment covers common binding and every dense non-manifest descriptor's kind, ordinal, identity, and canonical length | Missing/reordered/substituted payload tests |
| HC-1 object smuggling | Real HC-1 decoder, identity, project, digest, and dependency verification; object union remains frozen | Byte-identical import and dependency tests |
| HC-2 evidence confused with HC-1 authority | Separate v2 identity namespaces and attachment store; HC-2 attachments are evidence only | Kind-separation and namespace tests |
| Replay, rollback, gap, or fork | Full sender/recipient/purpose/generation stream key; post-decrypt sequence/predecessor CAS; explicit duplicate/stale/gap/fork outcomes | Continuity matrix tests |
| Partial outbound file advances sequence | Exact container journal plus close/reopen length, SHA-256, ID, and byte equality before CAS completion | Incremental framing and retry tests |
| Partial inbound state becomes visible | HC-1 objects and HC-2 attachments stage first; admission install precedes one combined marker written last | Failure-cut and admission tests |
| Epoch exposure or premature admission | Epoch stays inside the Slice 5 delivery envelope and v2 HPKE; custody installation happens through bounded open before visibility | Admission/receipt roundtrip tests |
| Oversize or decompression attack | Frozen absolute byte/count/depth limits, early rejection, definite CBOR only, no compression | Exact-limit and `+1` tests |
| Mixed-version downgrade | v1 and v2 parsers reject each other; Slice 6 accepts v2 only | Compatibility tests and frozen v1 fixture hash |
| Key exfiltration | X25519 and Ed25519 private handles are non-extractable; portable file contains ciphertext only | Two-profile Chrome evidence |

Residual operational risks are intentionally outside this disabled slice: user
misdelivery of an opaque file, loss of both device custody and recovery
material, and platform storage permission loss. These produce explicit failed
or read-only outcomes; they do not grant collaboration authority.

# HC-2 Slice 7 security review

Slice 7 remains unreachable from production entrypoints. Its barrel is the
side-effect-free HC-2-only barrel, which the production collaboration barrel
does not export. Providers are not exported from that barrel. Importing the
modules opens no file, database, OPFS root, lock, worker, network request,
random source, crypto context, timer, or UI capability.

| Risk | Control | Evidence |
| --- | --- | --- |
| V1/V2 wire change or downgrade | Separate V3 constants, domains, IDs, exact parsers and closed union | Frozen fixture hashes; cross-version rejection tests |
| Inventory/request metadata leaks | Same nine-field opaque public header; complete header is AAD | Node/Python/Chrome AAD vectors and outer-byte privacy scans |
| Index/cache invents authority | Stable two-generation read from injected committed portable bytes, with exact rehash and validation | Corrupt-index/empty-OPFS browser evidence; source-kind test |
| Malicious request extracts data | Offered-snapshot membership, project ownership, exact digest/length, allowed kind and dependency closure checked before response | Planner/runtime request tests and two-profile response harness |
| Sync message mutates accepted state | Every control payload is exact-field `authority: "none"`; existing HC-1/HC-2 validators remain mandatory | Frozen authority vector and atomic import tests |
| Partial import becomes visible | Complete container/manifest verification, isolated staging, combined verification, marker last, durable reopen before CAS | Failure/duplicate/browser convergence evidence |
| Stale or revoked peer receives new data | Accepted authority/control/key/epoch/capability revalidated before random/sign/HPKE | Zero-call revocation test and Chrome mid-session revocation |
| Replay or fork picks a winner | Exact commitment replay is idempotent; gap/fork/session conflict are typed and no arrival-time rule exists | Permutation, replay, gap, fork and reversed-arrival tests |
| Equal inventory hides divergent projection | Confirmation compares all authoritative/projected commitments independently | Divergent-reconstruction unit vector and reopened Chrome categories |
| Resource exhaustion or hidden liveness | Conservative page/object/byte/container/depth/message/round constants; one explicit invocation | Boundary and `more_required` tests; no timer/network/worker scan |

The full inventory/page method is intentionally linear and reveals inventory
shape to the authenticated recipient after decryption. It avoids false-positive
or probabilistic summaries and gives exact resume evidence. Size, file timing,
and container count remain observable to someone possessing the ciphertext;
semantic identifiers and routing meaning do not.

An attacker holding already-delivered ciphertext may retain and attempt it
after revocation. Slice 7 honestly cannot recall those bytes. Fresh exports are
blocked before cryptography, and import still requires the intended persisted
recipient key plus sender authentication and accepted-state validation.

No new dependency or lockfile change is required. Production collaboration is
still unconditionally disabled; network, background, and UI integration remain
outside this slice.

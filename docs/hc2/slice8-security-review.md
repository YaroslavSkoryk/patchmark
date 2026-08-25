# HC-2 Slice 8 integrated security review

Slice 8 is a disabled qualification layer, not production enablement.

| Risk | Integrated control |
| --- | --- |
| Source damage | Fresh-destination HC-1 duplication; source digest checked around successes and failures |
| Workflow invents authority | Guidance is `authority: "none"`; existing validators remain mandatory |
| Durable corruption is hidden | Portable/control/epoch/session evidence is revalidated; fork/corrupt/ambiguity blocks |
| Secret enters diagnostics | Secret-bearing names and byte buffers are rejected; reports contain commitments only |
| Manual substitution | Framing, recipient, signature, HPKE, stream, session, digest, project, control, and epoch checks fail closed |
| Metadata leaks | Frozen V2/V3 opaque nine-field header and complete-header AAD remain unchanged |
| Revoked peer receives data | Authority/epoch revalidation precedes random/sign/HPKE; post-cutoff work is rejected |
| Implicit conflict winner | HC-1 requires exact observed contenders and eligible explicit authority; reviewer is insufficient |
| Partial visibility | Existing marker-last transactions and IndexedDB CAS remain authoritative |
| Recovery clones a lost device | Root recovery allocates new identity/keys and restores no old sequence/reservation |
| Hidden activity | One bounded call; poisoned imports and idle counters cover storage, crypto, workers, timers, network, and UI |
| Production reachability | HC-2 remains outside production barrel; lock and chunk scans reject imports/flags |

The user-selected portable folder contains plaintext HC-1 history at rest; only
exchanged V2/V3 artifacts are encrypted. Physical possession, copying, backup,
deletion, and filesystem permissions remain outside browser cryptography.
Out-of-band identity decisions remain human responsibilities.

Revocation is prospective. It cannot erase plaintext, copied folders,
compromised keys, or already-delivered ciphertext. Manual file movement exposes
size/timing and permits denial, replacement, and replay; authentication prevents
those actions from becoming authority.

A compromised profile can use its keys until revocation. Non-extractable
WebCrypto objects are not guaranteed hardware-backed. JavaScript/WASM wiping is
best effort, and selected libraries/browser implementations are not claimed to
be formally audited.

There is no network, relay, background sync, account recovery service, remote
deletion, production UI, or HSM. Production remains disabled pending Slice 9.

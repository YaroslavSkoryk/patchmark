# HC-3 Slice 6 privacy and plaintext-at-rest approval package

Status: approval required; no product or privacy approval is recorded

## Proposed user-visible disclosure

> Collaboration creates a separate local copy of your project. The documents
> in that copy may remain readable on this device's disk. Encryption protects
> admission and update files while you carry them between devices, but it does
> not encrypt the local project folder. Backups, cloud-synced folders, shared
> operating-system accounts, malware, and a lost unlocked device may expose
> local content.
>
> Invitations and connection QR codes are not confidential. Encrypted admission
> and update files hide their contents but reveal approximate size and timing.
> A direct connection shares network information with the intended peer and may
> fail across the internet because Patchmark has no relay or public traversal
> service. You can exchange encrypted update files instead.
>
> Revoking a device blocks future accepted work from it but cannot erase data
> the device already received. A newly admitted device verifies the current
> accepted state; Patchmark does not claim it traversed the complete project
> history. Store recovery material separately. If this browser loses its
> device keys, use recovery or admit the device again. Patchmark has no server
> that can retrieve, repair, or decrypt a local project.

The disclosure must appear before setup and remain accessible from Privacy and
Safety. Invitation, QR, clipboard, messenger, file-provider, direct-network,
revocation, partial-history, recovery and at-rest statements must not be
collapsed into a claim that collaboration is anonymous or that transport
encryption encrypts local storage.

## Product decision

### 1. Accept plaintext local project storage

Keep ordinary portable Markdown and authority files. Usability, local search,
previews, interoperability, incremental backups and repair remain closest to
single-user Patchmark. Recovery covers device authority, not disk
confidentiality. Users must understand backups, synced folders, shared accounts
and lost-device exposure. Migration is minimal and release timing is shortest,
but product/privacy owners explicitly accept the disclosure and support burden.

### 2. Require encrypted-at-rest collaboration projects

Block release until a separate project-format design covers key derivation,
multi-device custody, recovery, rotation, revocation, crash safety, indexing,
search, previews, diffs, backup deduplication, partial restore, repair,
interoperability, explicit migration, rollback and exports. Usability and
support complexity increase; loss of keys may make local content permanently
unavailable. This option cannot be implemented by exporting existing
non-extractable device keys or silently rewriting projects. Release timing is
longest and requires new protocol/storage qualification.

### 3. Technical preview pending encrypted-at-rest design

Restrict the first release to an explicitly labeled preview with a narrow
audience and the same disclosure. Search, previews, backups and interoperability
remain usable, while product avoids claiming a general confidentiality posture.
Preview users still create real portable authority, so format compatibility,
recovery, support and rollback commitments remain. This shortens timing only if
legal, privacy, security and product owners accept the preview scope and clear
exit criteria.

## Required approval record

Record one numbered choice, approved disclosure bytes/hash, supported use case,
prohibited storage locations if any, preview label if any, migration commitment,
support owner, approver names/roles and approval date. Security review does not
substitute for product/privacy approval. Slice 6 records no approval.

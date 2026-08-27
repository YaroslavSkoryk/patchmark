# HC-3 Slice 5 plaintext-at-rest decision record

Status: accepted limitation requiring product and privacy approval before production enablement

## Decision

Slice 5 does not add transparent project encryption. Patchmark collaboration
transport encryption protects admission and synchronization artifacts while
they are carried between devices; it does not encrypt the selected local
project folder. Treating these as the same protection would be misleading.

This limitation does not prevent continued enablement design, but it blocks
production enablement until product and privacy owners approve the warning,
supported-platform assumptions, and either accept the limitation or fund a
separate encrypted-at-rest project format.

## Current storage model

The portable collaboration directory can contain plaintext Markdown,
manifests, accepted semantic and control records, projections, conflict
records, tombstones, roots, checkpoints, and other durable evidence needed to
reconstruct the project. IDs, filenames, directory shape, approximate object
counts, timestamps where present, and file sizes are likewise visible to the
local filesystem. Existing single-user Patchmark projects already expose
their Markdown and local project metadata in the chosen folder.

Admission and synchronization bundle files remain encrypted according to the
existing HC-2 envelopes. Device-private signing, HPKE, and epoch custody stay
as non-extractable browser `CryptoKey` objects in the device's IndexedDB
profile. Recovery material is separately user-carried and must not be written
into the portable project. Optional UI guidance is non-authoritative and must
never be used to infer membership, epoch, device, or accepted object state.

## Exposure

Plaintext project data may be copied by ordinary and enterprise backups,
desktop search and content indexing, malware with account access, other users
of a shared or unlocked operating-system account, cloud-synchronized folders,
filesystem snapshots, repair tools, preview generators, and anyone who gains
an unlocked lost device. Disk or home-directory encryption can reduce some
lost-device exposure, but Patchmark does not detect or guarantee it.

Transport artifacts have different exposure. Invitations, Responses, direct
connection descriptions, and QR codes are not confidential. Encrypted V2/V3
files conceal their content but reveal approximate size and timing. Browser,
clipboard, messenger, operating-system, download, and file-provider histories
may retain those artifacts. Revocation cannot recall plaintext or encrypted
artifacts already delivered.

## Required product language

Before collaboration setup, ordinary-language guidance must say that:

- a separate collaboration copy is created;
- transfer files are encrypted, but local project files may remain readable;
- backups, indexing, shared accounts, synchronized folders, malware, and lost
  unlocked devices can expose local content;
- recovery material belongs in a separate safe place;
- loss of non-extractable device custody requires recovery or re-admission;
- revocation prevents future accepted work but does not erase another copy.

The Slice 5 workspace includes this language contextually and keeps technical
detail in a disclosure. It never describes WebRTC as anonymous or transport
encryption as encrypted local storage.

## Future encrypted format options

A future project format could encrypt whole files, immutable objects, or
content-addressed chunks. Each option needs a new architecture decision for
key derivation and custody, multi-device recovery, owner loss, rotation,
revocation, crash-safe transactions, search, preview, thumbnails, diffing,
backup deduplication, partial restore, migration, export, and performance.
Transparent migration of existing projects is forbidden: users would need an
explicit new destination, verifiable copy, rollback plan, compatibility
commitment, and recovery rehearsal.

Per-object encryption best preserves immutable storage and incremental backup
behavior but leaks structure and requires careful key/version binding.
Whole-project containers hide more structure but complicate random access,
concurrent windows, recovery, repair, and large-project writes. Operating-
system-only protection is simpler but cannot provide a Patchmark portability
or recovery guarantee. None belongs in HC-3 Slice 5.

## Acceptance rule

Encrypted-at-rest work is a documented product limitation rather than a
protocol-correctness blocker. It is nevertheless a production decision
blocker until an independent privacy review approves the user language and
the product owner explicitly accepts the exposure for the supported use case.
Any later encrypted format is a separate protocol/storage project, not a
condition to weaken existing non-extractable custody or transport validation.

import {
  canonicalProtocolValue,
  protocolValueFromCanonical
} from "./canonical-protocol.ts";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "./canonical-cbor.ts";
import {
  parseAcknowledgementRecord,
  parseProjectionSnapshotRecord,
  type AcknowledgementRecord,
  type ProjectionSnapshotRecord
} from "./checkpoints.ts";
import type {
  AcknowledgementId,
  CheckpointId,
  DeviceId,
  ProjectId,
  SnapshotId,
  StateBlobId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import {
  deriveAcknowledgementIdentity,
  deriveProjectionSnapshotIdentity
} from "./preimages.ts";
import {
  deriveCanonicalStateBlobIdentity,
  parseCanonicalStateBlobRecord,
  type CanonicalStateBlobRecord
} from "./state-snapshots.ts";
import {
  collaborationAcknowledgementReservationAddress,
  collaborationObjectAddresses,
  collaborationStoragePrefixes,
  objectIdFromStorageAddress,
  type CollaborationByteStorageBackend,
  type CollaborationObjectIdByKind,
  type CollaborationReadResult,
  type CollaborationStorageAddress
} from "./storage.ts";
import { bytesEqual, bytesToHex } from "./bytes.ts";
import { sha256 } from "./sha256.ts";
import {
  ACKNOWLEDGEMENT_SEQUENCE_RESERVATION_VERSION
} from "./versions.ts";
import type { PreparedAcknowledgementDraft } from "./acknowledgements.ts";
import type { FullHistoryCheckpointVerificationResult } from "./checkpoint-verification.ts";

export type Slice6StorageFailureStage =
  | "state_blob_staging"
  | "state_blob_data"
  | "state_blob_commit"
  | "snapshot_staging"
  | "snapshot_data"
  | "snapshot_commit"
  | "acknowledgement_reservation"
  | "acknowledgement_data"
  | "acknowledgement_commit"
  | "after_checkpoint_verification_before_state_blob"
  | "after_state_blob_before_snapshot"
  | "during_slice6_reopening";

export type Slice6StorageFailureInjector = (
  context: Readonly<{
    stage: Slice6StorageFailureStage;
    object_id?: StateBlobId | SnapshotId | AcknowledgementId;
    project_id?: ProjectId;
    device_id?: DeviceId;
  }>
) => void | Promise<void>;

export type AcknowledgementSequenceReservation = Readonly<{
  reservation_version: typeof ACKNOWLEDGEMENT_SEQUENCE_RESERVATION_VERSION;
  object_kind: "acknowledgement_sequence_reservation";
  reservation_state: "pending" | "committed";
  project_id: ProjectId;
  device_id: DeviceId;
  acknowledgement_id: AcknowledgementId;
  acknowledgement_sequence: bigint;
  previous_acknowledgement_id: AcknowledgementId | null;
  canonical_core_bytes: Uint8Array;
}>;

export type Slice6RecoveryReport = Readonly<{
  valid_state_blob_ids: readonly StateBlobId[];
  valid_snapshot_ids: readonly SnapshotId[];
  valid_acknowledgement_ids: readonly AcknowledgementId[];
  pending_acknowledgement_reservations: readonly AcknowledgementSequenceReservation[];
  resumed_acknowledgement_reservations: readonly AcknowledgementSequenceReservation[];
  incomplete_addresses: readonly CollaborationStorageAddress[];
  corrupted_addresses: readonly CollaborationStorageAddress[];
  cleaned_staging_addresses: readonly CollaborationStorageAddress[];
}>;

type Slice6Kind = "state-blob" | "snapshot" | "acknowledgement";
type Slice6Id = StateBlobId | SnapshotId | AcknowledgementId;
type RawSlice6Read =
  | Readonly<{ status: "valid"; bytes: Uint8Array; value: Uint8Array }>
  | Readonly<{
      status: "missing" | "incomplete" | "corrupted" | "mismatched";
      reason: string;
    }>;

export class ConsolidationCollaborationStore {
  readonly #backend: CollaborationByteStorageBackend;
  readonly #inject?: Slice6StorageFailureInjector;

  constructor(options: Readonly<{
    backend: CollaborationByteStorageBackend;
    failure_injector?: Slice6StorageFailureInjector;
  }>) {
    if (!options || typeof options.backend !== "object" || options.backend === null) {
      throw new Error("Consolidation storage requires an injected byte backend.");
    }
    this.#backend = options.backend;
    this.#inject = options.failure_injector;
  }

  async putVerifiedStateBlob(
    verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>,
    value: CanonicalStateBlobRecord
  ): Promise<Readonly<{ status: "stored" | "already_present"; id: StateBlobId }>> {
    const record = parseCanonicalStateBlobRecord(value);
    if (record.core.checkpoint_id !== verification.checkpoint_id) {
      throw new Error("State blob storage requires its exact verified checkpoint.");
    }
    const identity = await deriveCanonicalStateBlobIdentity(record.core);
    if (identity.id !== record.state_blob_id) throw new Error("State blob identity mismatch.");
    const bytes = encodeRecord(record);
    const status = await this.#put("state-blob", record.state_blob_id, bytes, async (candidate) => {
      const decoded = decodeStateBlobRecord(candidate);
      const derived = await deriveCanonicalStateBlobIdentity(decoded.core);
      if (derived.id !== decoded.state_blob_id) throw new Error("Stored state blob identity mismatch.");
    });
    return Object.freeze({ status, id: record.state_blob_id });
  }

  async getStateBlob(idValue: StateBlobId): Promise<CollaborationReadResult<CanonicalStateBlobRecord>> {
    const id = parseDigestId("state-blob", idValue);
    return this.#get("state-blob", id, async (bytes) => {
      const record = decodeStateBlobRecord(bytes);
      const identity = await deriveCanonicalStateBlobIdentity(record.core);
      if (identity.id !== id || record.state_blob_id !== id) throw new Error("State blob identity mismatch.");
      return record;
    });
  }

  async putVerifiedSnapshot(
    verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>,
    stateBlob: CanonicalStateBlobRecord,
    value: ProjectionSnapshotRecord
  ): Promise<Readonly<{ status: "stored" | "already_present"; id: SnapshotId }>> {
    const snapshot = parseProjectionSnapshotRecord(value, verification.checkpoint_id);
    if (snapshot.core.state_blob_id !== stateBlob.state_blob_id) {
      throw new Error("Snapshot storage requires its exact verified state blob.");
    }
    const stateRead = await this.getStateBlob(stateBlob.state_blob_id);
    if (stateRead.status !== "valid") {
      throw new Error("A snapshot cannot be stored before its state blob is committed.");
    }
    const identity = await deriveProjectionSnapshotIdentity(snapshot.core);
    if (identity.id !== snapshot.snapshot_id) throw new Error("Snapshot identity mismatch.");
    const status = await this.#put("snapshot", snapshot.snapshot_id, encodeRecord(snapshot), async (candidate) => {
      const decoded = decodeSnapshotRecord(candidate);
      const derived = await deriveProjectionSnapshotIdentity(decoded.core);
      if (derived.id !== decoded.snapshot_id) throw new Error("Stored snapshot identity mismatch.");
    });
    return Object.freeze({ status, id: snapshot.snapshot_id });
  }

  async getSnapshot(idValue: SnapshotId): Promise<CollaborationReadResult<ProjectionSnapshotRecord>> {
    const id = parseDigestId("snapshot", idValue);
    return this.#get("snapshot", id, async (bytes) => {
      const record = decodeSnapshotRecord(bytes);
      const identity = await deriveProjectionSnapshotIdentity(record.core);
      if (identity.id !== id || record.snapshot_id !== id) throw new Error("Snapshot identity mismatch.");
      return record;
    });
  }

  async reserveAcknowledgement(
    draft: PreparedAcknowledgementDraft
  ): Promise<Readonly<{ status: "reserved" | "already_reserved"; reservation: AcknowledgementSequenceReservation }>> {
    const address = collaborationAcknowledgementReservationAddress(
      draft.core.project_id,
      draft.core.device_id
    );
    const reservation = parseReservation({
      reservation_version: ACKNOWLEDGEMENT_SEQUENCE_RESERVATION_VERSION,
      object_kind: "acknowledgement_sequence_reservation",
      reservation_state: "pending",
      project_id: draft.core.project_id,
      device_id: draft.core.device_id,
      acknowledgement_id: draft.acknowledgement_id,
      acknowledgement_sequence: draft.core.acknowledgement_sequence,
      previous_acknowledgement_id: draft.core.previous_acknowledgement_id,
      canonical_core_bytes: draft.canonical_core_bytes
    });
    const existing = await this.#backend.read(address);
    if (existing !== null) {
      const parsed = decodeReservation(existing);
      if (
        parsed.acknowledgement_id !== reservation.acknowledgement_id ||
        !bytesEqual(parsed.canonical_core_bytes, reservation.canonical_core_bytes)
      ) {
        throw new Error("Acknowledgement sequence reservation conflicts with another draft.");
      }
      return Object.freeze({ status: "already_reserved" as const, reservation: parsed });
    }
    await this.#backend.write(address, encodeRecord(reservation), { stage: "sequence_reservation" });
    await this.#fail({
      stage: "acknowledgement_reservation",
      object_id: reservation.acknowledgement_id,
      project_id: reservation.project_id,
      device_id: reservation.device_id
    });
    return Object.freeze({ status: "reserved" as const, reservation });
  }

  async commitAcknowledgement(
    value: AcknowledgementRecord
  ): Promise<Readonly<{ status: "stored" | "already_present"; id: AcknowledgementId }>> {
    const checkpointId = value.core.acknowledged_checkpoint_id;
    const record = parseAcknowledgementRecord(value, checkpointId);
    const identity = await deriveAcknowledgementIdentity(record.core);
    if (identity.id !== record.acknowledgement_id) throw new Error("Acknowledgement identity mismatch.");
    const address = collaborationAcknowledgementReservationAddress(
      record.core.project_id,
      record.core.device_id
    );
    const rawReservation = await this.#backend.read(address);
    if (rawReservation === null) throw new Error("Acknowledgement commit requires a durable sequence reservation.");
    const reservation = decodeReservation(rawReservation);
    if (
      reservation.acknowledgement_id !== record.acknowledgement_id ||
      reservation.acknowledgement_sequence !== record.core.acknowledgement_sequence
    ) {
      throw new Error("Acknowledgement record does not match its sequence reservation.");
    }
    const status = await this.#put(
      "acknowledgement",
      record.acknowledgement_id,
      encodeRecord(record),
      async (candidate) => {
        const decoded = decodeAcknowledgementRecord(candidate);
        const derived = await deriveAcknowledgementIdentity(decoded.core);
        if (derived.id !== decoded.acknowledgement_id) throw new Error("Stored acknowledgement identity mismatch.");
      }
    );
    const committed = Object.freeze({ ...reservation, reservation_state: "committed" as const });
    await this.#backend.write(address, encodeRecord(committed), { stage: "derived_index" });
    return Object.freeze({ status, id: record.acknowledgement_id });
  }

  async getAcknowledgement(
    idValue: AcknowledgementId
  ): Promise<CollaborationReadResult<AcknowledgementRecord>> {
    const id = parseDigestId("acknowledgement", idValue);
    return this.#get("acknowledgement", id, async (bytes) => {
      const record = decodeAcknowledgementRecord(bytes);
      const identity = await deriveAcknowledgementIdentity(record.core);
      if (identity.id !== id || record.acknowledgement_id !== id) {
        throw new Error("Acknowledgement identity mismatch.");
      }
      return record;
    });
  }

  async persistCheckpointArtifacts(
    verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>,
    stateBlob: CanonicalStateBlobRecord,
    snapshot: ProjectionSnapshotRecord
  ): Promise<void> {
    await this.#fail({
      stage: "after_checkpoint_verification_before_state_blob",
      object_id: stateBlob.state_blob_id
    });
    await this.putVerifiedStateBlob(verification, stateBlob);
    await this.#fail({
      stage: "after_state_blob_before_snapshot",
      object_id: snapshot.snapshot_id
    });
    await this.putVerifiedSnapshot(verification, stateBlob, snapshot);
  }

  async recover(): Promise<Slice6RecoveryReport> {
    await this.#fail({ stage: "during_slice6_reopening" });
    const validState: StateBlobId[] = [];
    const validSnapshots: SnapshotId[] = [];
    const validAcknowledgements: AcknowledgementId[] = [];
    const incomplete: CollaborationStorageAddress[] = [];
    const corrupted: CollaborationStorageAddress[] = [];
    const cleaned: CollaborationStorageAddress[] = [];
    const staging = await this.#backend.list(collaborationStoragePrefixes.staging);
    for (const address of staging) {
      const addressed = objectIdFromStorageAddress(address);
      if (!addressed || !isSlice6Kind(addressed.kind)) continue;
      // The commit marker, never staging residue, controls visibility.
      await this.#backend.delete(address);
      cleaned.push(address);
    }
    const dataObjects = await this.#backend.list(collaborationStoragePrefixes.data);
    for (const address of dataObjects) {
      const object = objectIdFromStorageAddress(address);
      if (!object || !isSlice6Kind(object.kind)) continue;
      const objectAddresses = collaborationObjectAddresses(object.kind, object.id as never);
      const commit = await this.#backend.read(objectAddresses.commit);
      if (commit === null) incomplete.push(address);
    }
    const commits = await this.#backend.list(collaborationStoragePrefixes.commits);
    for (const address of commits) {
      const object = objectIdFromStorageAddress(address);
      if (!object || !isSlice6Kind(object.kind)) continue;
      const result = object.kind === "state-blob"
        ? await this.getStateBlob(parseDigestId("state-blob", object.id))
        : object.kind === "snapshot"
          ? await this.getSnapshot(parseDigestId("snapshot", object.id))
          : await this.getAcknowledgement(parseDigestId("acknowledgement", object.id));
      if (result.status === "valid") {
        if (object.kind === "state-blob") validState.push(parseDigestId("state-blob", object.id));
        else if (object.kind === "snapshot") validSnapshots.push(parseDigestId("snapshot", object.id));
        else validAcknowledgements.push(parseDigestId("acknowledgement", object.id));
      } else if (result.status === "missing" || result.status === "incomplete") {
        incomplete.push(address);
      } else {
        corrupted.push(address);
      }
    }
    const pending: AcknowledgementSequenceReservation[] = [];
    const resumed: AcknowledgementSequenceReservation[] = [];
    const reservations = await this.#backend.list(
      collaborationStoragePrefixes.acknowledgementReservations
    );
    for (const address of reservations) {
      const bytes = await this.#backend.read(address);
      if (bytes === null) continue;
      try {
        const reservation = decodeReservation(bytes);
        if (reservation.reservation_state === "committed") continue;
        const record = await this.getAcknowledgement(reservation.acknowledgement_id);
        if (record.status === "valid") {
          const committed = Object.freeze({ ...reservation, reservation_state: "committed" as const });
          await this.#backend.write(address, encodeRecord(committed), { stage: "derived_index" });
          resumed.push(committed);
        } else {
          pending.push(reservation);
        }
      } catch {
        corrupted.push(address);
      }
    }
    return Object.freeze({
      valid_state_blob_ids: Object.freeze(validState.sort()),
      valid_snapshot_ids: Object.freeze(validSnapshots.sort()),
      valid_acknowledgement_ids: Object.freeze(validAcknowledgements.sort()),
      pending_acknowledgement_reservations: Object.freeze(pending),
      resumed_acknowledgement_reservations: Object.freeze(resumed),
      incomplete_addresses: Object.freeze(incomplete.sort()),
      corrupted_addresses: Object.freeze(corrupted.sort()),
      cleaned_staging_addresses: Object.freeze(cleaned.sort())
    });
  }

  async #put<TKind extends Slice6Kind>(
    kind: TKind,
    id: CollaborationObjectIdByKind[TKind],
    bytesValue: Uint8Array,
    verify: (bytes: Uint8Array) => Promise<void>
  ): Promise<"stored" | "already_present"> {
    const addresses = collaborationObjectAddresses(kind, id);
    const existing = await this.#readRaw(kind, id);
    if (existing.status === "valid") {
      await verify(existing.bytes);
      if (!bytesEqual(existing.bytes, bytesValue)) throw new Error("Immutable object ID collision.");
      return "already_present";
    }
    if (existing.status === "corrupted" || existing.status === "mismatched") {
      throw new Error(`Refusing to overwrite ${existing.status} immutable ${kind} storage.`);
    }
    const bytes = Uint8Array.from(bytesValue);
    await this.#backend.write(addresses.staging, bytes, { stage: "staging" });
    await this.#fail({ stage: stageFor(kind, "staging"), object_id: id });
    const staged = await this.#backend.read(addresses.staging);
    if (staged === null || !bytesEqual(staged, bytes)) throw new Error("Slice 6 staging verification failed.");
    await verify(staged);
    await this.#backend.write(addresses.data, bytes, { stage: "object_data" });
    await this.#fail({ stage: stageFor(kind, "data"), object_id: id });
    const stored = await this.#backend.read(addresses.data);
    if (stored === null || !bytesEqual(stored, bytes)) throw new Error("Slice 6 data verification failed.");
    await verify(stored);
    const marker = await encodeCommitMarker(kind, id, stored);
    await this.#backend.write(addresses.commit, marker, { stage: "commit_marker" });
    await this.#fail({ stage: stageFor(kind, "commit"), object_id: id });
    await this.#backend.delete(addresses.staging);
    return "stored";
  }

  async #get<TKind extends Slice6Kind, TValue>(
    kind: TKind,
    id: CollaborationObjectIdByKind[TKind],
    decode: (bytes: Uint8Array) => Promise<TValue>
  ): Promise<CollaborationReadResult<TValue>> {
    const raw = await this.#readRaw(kind, id);
    if (raw.status !== "valid") return raw;
    try {
      return Object.freeze({ status: "valid" as const, value: await decode(raw.bytes) });
    } catch (error) {
      return Object.freeze({ status: "corrupted" as const, reason: errorMessage(error) });
    }
  }

  async #readRaw<TKind extends Slice6Kind>(
    kind: TKind,
    id: CollaborationObjectIdByKind[TKind]
  ): Promise<RawSlice6Read> {
    const addresses = collaborationObjectAddresses(kind, id);
    const [data, commit] = await Promise.all([
      this.#backend.read(addresses.data),
      this.#backend.read(addresses.commit)
    ]);
    if (data === null && commit === null) return Object.freeze({ status: "missing" as const, reason: "Object is absent." });
    if (data === null || commit === null) return Object.freeze({ status: "incomplete" as const, reason: "Object data or commit marker is absent." });
    try {
      const marker = decodeCommitMarker(commit);
      const digest = bytesToHex(await sha256(data));
      if (marker.kind !== kind || marker.id !== id || marker.byte_length !== data.length || marker.sha256 !== digest) {
        return Object.freeze({ status: "mismatched" as const, reason: "Object commit marker does not match data." });
      }
      return Object.freeze({ status: "valid" as const, value: Uint8Array.from(data), bytes: Uint8Array.from(data) });
    } catch (error) {
      return Object.freeze({ status: "corrupted" as const, reason: errorMessage(error) });
    }
  }

  async #fail(context: Parameters<NonNullable<Slice6StorageFailureInjector>>[0]): Promise<void> {
    await this.#inject?.(context);
  }
}

function encodeRecord(value: unknown): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(value));
}

function decodeRecord(bytes: Uint8Array, bigintIntegers = false): unknown {
  return protocolValueFromCanonical(
    decodeCanonicalCbor(Uint8Array.from(bytes)),
    bigintIntegers ? "bigint" : "number_when_safe"
  );
}

function decodeStateBlobRecord(bytes: Uint8Array): CanonicalStateBlobRecord {
  return parseCanonicalStateBlobRecord(decodeRecord(bytes));
}

function decodeSnapshotRecord(bytes: Uint8Array): ProjectionSnapshotRecord {
  const value = decodeRecord(bytes) as Readonly<Record<string, unknown>>;
  const core = value.core as Readonly<Record<string, unknown>>;
  const checkpointId = parseDigestId("semantic-event", core.checkpoint_id) as CheckpointId;
  return parseProjectionSnapshotRecord(value, checkpointId);
}

function decodeAcknowledgementRecord(bytes: Uint8Array): AcknowledgementRecord {
  const value = decodeRecord(bytes) as Record<string, unknown>;
  const core = value.core as Record<string, unknown>;
  core.acknowledgement_sequence = BigInt(core.acknowledgement_sequence as number);
  if (Array.isArray(core.highest_contiguous_semantic_sequences)) {
    for (const entry of core.highest_contiguous_semantic_sequences as Array<Record<string, unknown>>) {
      entry.highest_contiguous_sequence = BigInt(entry.highest_contiguous_sequence as number);
    }
  }
  const checkpointId = parseDigestId("semantic-event", core.acknowledged_checkpoint_id) as CheckpointId;
  return parseAcknowledgementRecord(value, checkpointId);
}

function parseReservation(value: unknown): AcknowledgementSequenceReservation {
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.reservation_version !== ACKNOWLEDGEMENT_SEQUENCE_RESERVATION_VERSION ||
    record.object_kind !== "acknowledgement_sequence_reservation" ||
    (record.reservation_state !== "pending" && record.reservation_state !== "committed") ||
    !isUnsignedInteger(record.acknowledgement_sequence) ||
    !(record.canonical_core_bytes instanceof Uint8Array)
  ) {
    throw new Error("Malformed acknowledgement sequence reservation.");
  }
  const keys = Object.keys(record).sort();
  const expected = [
    "acknowledgement_id",
    "acknowledgement_sequence",
    "canonical_core_bytes",
    "device_id",
    "object_kind",
    "previous_acknowledgement_id",
    "project_id",
    "reservation_state",
    "reservation_version"
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Acknowledgement reservation contains unknown fields.");
  }
  return Object.freeze({
    reservation_version: ACKNOWLEDGEMENT_SEQUENCE_RESERVATION_VERSION,
    object_kind: "acknowledgement_sequence_reservation" as const,
    reservation_state: record.reservation_state,
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    acknowledgement_id: parseDigestId("acknowledgement", record.acknowledgement_id),
    acknowledgement_sequence: typeof record.acknowledgement_sequence === "bigint"
      ? record.acknowledgement_sequence
      : BigInt(record.acknowledgement_sequence as number),
    previous_acknowledgement_id: record.previous_acknowledgement_id === null
      ? null
      : parseDigestId("acknowledgement", record.previous_acknowledgement_id),
    canonical_core_bytes: Uint8Array.from(record.canonical_core_bytes)
  });
}

function decodeReservation(bytes: Uint8Array): AcknowledgementSequenceReservation {
  return parseReservation(decodeRecord(bytes));
}

async function encodeCommitMarker(kind: Slice6Kind, id: Slice6Id, bytes: Uint8Array): Promise<Uint8Array> {
  return encodeRecord({
    marker_version: 1,
    object_kind: "slice6_commit_marker",
    kind,
    id,
    byte_length: bytes.length,
    sha256: bytesToHex(await sha256(bytes))
  });
}

function decodeCommitMarker(bytes: Uint8Array): Readonly<{
  kind: Slice6Kind;
  id: Slice6Id;
  byte_length: number;
  sha256: string;
}> {
  const value = decodeRecord(bytes) as Readonly<Record<string, unknown>>;
  if (
    value.marker_version !== 1 ||
    value.object_kind !== "slice6_commit_marker" ||
    !isSlice6Kind(value.kind) ||
    typeof value.byte_length !== "number" ||
    typeof value.sha256 !== "string"
  ) {
    throw new Error("Malformed Slice 6 commit marker.");
  }
  const id = value.kind === "state-blob"
    ? parseDigestId("state-blob", value.id)
    : value.kind === "snapshot"
      ? parseDigestId("snapshot", value.id)
      : parseDigestId("acknowledgement", value.id);
  return Object.freeze({ kind: value.kind, id, byte_length: value.byte_length, sha256: value.sha256 });
}

function stageFor(
  kind: Slice6Kind,
  stage: "staging" | "data" | "commit"
): Slice6StorageFailureStage {
  return `${kind === "state-blob" ? "state_blob" : kind}_${stage}` as Slice6StorageFailureStage;
}

function isSlice6Kind(value: unknown): value is Slice6Kind {
  return value === "state-blob" || value === "snapshot" || value === "acknowledgement";
}

function isUnsignedInteger(value: unknown): value is number | bigint {
  return typeof value === "bigint"
    ? value >= BigInt(0)
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

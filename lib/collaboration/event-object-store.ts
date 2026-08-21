import { bytesEqual, bytesToHex } from "./bytes.ts";
import type { AttestationCore, AttestationRecord } from "./checkpoints.ts";
import {
  parseAttestationCore,
  parseAttestationRecord
} from "./checkpoints.ts";
import type {
  ControlActionCore,
  ControlActionRecord,
  ControlEventRecord
} from "./control.ts";
import {
  parseControlActionCore,
  parseControlEventRecordStructure
} from "./control.ts";
import {
  decodeStoredAttestation,
  decodeStoredControlAction,
  decodeStoredControlEvent,
  decodeStoredSemanticEvent,
  decodeStoredSemanticPayload,
  encodeStoredAttestation,
  encodeStoredControlAction,
  encodeStoredControlEvent,
  encodeStoredSemanticEvent,
  encodeStoredSemanticPayload
} from "./event-storage-codec.ts";
import {
  parseDigestId,
  parseEntityId,
  type AttestationId,
  type ControlActionId,
  type ControlEventId,
  type ProjectId,
  type SemanticEventId,
  type SemanticPayloadId
} from "./identities.ts";
import {
  deriveAttestationIdentity,
  deriveControlActionIdentity,
  deriveControlEventCoreIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity
} from "./preimages.ts";
import type {
  SemanticEventRecord,
  SemanticPayloadCore,
  SemanticPayloadRecord
} from "./semantic.ts";
import {
  parseSemanticEventRecordStructure,
  parseSemanticPayloadCore,
  parseSemanticPayloadRecord
} from "./semantic.ts";
import { sha256 } from "./sha256.ts";
import {
  CollaborationStoreError,
  collaborationObjectAddresses,
  collaborationStoragePrefixes,
  objectIdFromStorageAddress,
  parseCollaborationObjectId,
  type CollaborationByteStorageBackend,
  type CollaborationEventObjectKind,
  type CollaborationObjectIdByKind,
  type CollaborationPutResult,
  type CollaborationReadResult,
  type CollaborationStorageAddress,
  type CollaborationStoragePrefix,
  type CollaborationStoreFailureInjector
} from "./storage.ts";

type EventObjectRecordByKind = {
  "semantic-payload": SemanticPayloadRecord;
  "control-action": ControlActionRecord;
  "semantic-event": SemanticEventRecord;
  "control-event": ControlEventRecord;
  attestation: AttestationRecord;
};

export type EventObjectScanEntry<TKind extends CollaborationEventObjectKind> =
  Readonly<{
    kind: TKind;
    id: CollaborationObjectIdByKind[TKind];
    project_id: ProjectId | null;
    result: CollaborationReadResult<EventObjectRecordByKind[TKind]>;
  }>;

export type EventObjectRecoveryReport = Readonly<{
  valid_object_ids: readonly (
    | SemanticPayloadId
    | ControlActionId
    | SemanticEventId
    | ControlEventId
    | AttestationId
  )[];
  incomplete_addresses: readonly CollaborationStorageAddress[];
  corrupted_object_ids: readonly string[];
  mismatched_object_ids: readonly string[];
  cleaned_staging_addresses: readonly CollaborationStorageAddress[];
  invalid_addresses: readonly string[];
}>;

type EventObjectMetadata<TKind extends CollaborationEventObjectKind> = Readonly<{
  kind: TKind;
  id: CollaborationObjectIdByKind[TKind];
  project_id: ProjectId;
}>;

type ParsedCommitMarker = Readonly<{
  kind: CollaborationEventObjectKind;
  id:
    | SemanticPayloadId
    | ControlActionId
    | SemanticEventId
    | ControlEventId
    | AttestationId;
  project_id: ProjectId;
  stored_byte_length: number;
  stored_sha256: string;
}>;

type RawStoredRead =
  | Readonly<{
      status: "valid";
      bytes: Uint8Array;
      marker: ParsedCommitMarker;
    }>
  | Readonly<{
      status: "missing" | "incomplete" | "corrupted" | "mismatched";
      reason: string;
      marker?: ParsedCommitMarker;
    }>;

const commitHeader = "patchmark/collaboration-object-commit/v1";

export class ImmutableEventObjectStore {
  readonly #backend: CollaborationByteStorageBackend;
  readonly #failureInjector?: CollaborationStoreFailureInjector;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: Readonly<{
    backend: CollaborationByteStorageBackend;
    failure_injector?: CollaborationStoreFailureInjector;
  }>) {
    if (!options || typeof options.backend !== "object" || options.backend === null) {
      throw new Error("Immutable event storage requires an injected byte backend.");
    }
    this.#backend = options.backend;
    this.#failureInjector = options.failure_injector;
  }

  async putSemanticPayload(
    value: SemanticPayloadCore
  ): Promise<CollaborationPutResult<SemanticPayloadId, SemanticPayloadRecord>> {
    const core = parseSemanticPayloadCore(value);
    const identity = await deriveSemanticPayloadIdentity(core);
    const record = parseSemanticPayloadRecord({
      record_version: 1,
      object_kind: "semantic_payload",
      payload_id: identity.id,
      core
    });
    const status = await this.#putRecord(
      { kind: "semantic-payload", id: identity.id, project_id: core.project_id },
      encodeStoredSemanticPayload(record),
      decodeStoredSemanticPayload
    );
    return Object.freeze({ status, id: identity.id, value: record });
  }

  async putControlAction(
    value: ControlActionCore
  ): Promise<CollaborationPutResult<ControlActionId, ControlActionRecord>> {
    const core = parseControlActionCore(value);
    const identity = await deriveControlActionIdentity(core);
    const record = Object.freeze({
      record_version: 1 as const,
      object_kind: "control_action" as const,
      action_id: identity.id,
      core
    });
    const status = await this.#putRecord(
      { kind: "control-action", id: identity.id, project_id: core.project_id },
      encodeStoredControlAction(record),
      decodeStoredControlAction
    );
    return Object.freeze({ status, id: identity.id, value: record });
  }

  async putAttestationCore(
    value: AttestationCore
  ): Promise<CollaborationPutResult<AttestationId, AttestationRecord>> {
    const core = parseAttestationCore(value);
    const identity = await deriveAttestationIdentity(core);
    return this.putAttestationRecord({
      record_version: 1,
      object_kind: "attestation",
      attestation_id: identity.id,
      core
    });
  }

  async putAttestationRecord(
    value: AttestationRecord
  ): Promise<CollaborationPutResult<AttestationId, AttestationRecord>> {
    const record = parseAttestationRecord(value);
    const identity = await deriveAttestationIdentity(record.core);
    if (identity.id !== record.attestation_id) {
      throw new CollaborationStoreError(
        "mismatched",
        "Attestation record ID does not match its canonical core."
      );
    }
    const status = await this.#putRecord(
      {
        kind: "attestation",
        id: record.attestation_id,
        project_id: record.core.project_id
      },
      encodeStoredAttestation(record),
      decodeStoredAttestation
    );
    return Object.freeze({
      status,
      id: record.attestation_id,
      value: copyAttestation(record)
    });
  }

  async ingestSemanticEvent(
    value: SemanticEventRecord
  ): Promise<CollaborationPutResult<SemanticEventId, SemanticEventRecord>> {
    const record = parseSemanticEventRecordStructure(value);
    const identity = await deriveSemanticEventCoreIdentity(record.core);
    if (identity.id !== record.event_id) {
      throw new CollaborationStoreError(
        "mismatched",
        "Semantic event record ID does not match its canonical core."
      );
    }
    const status = await this.#putRecord(
      {
        kind: "semantic-event",
        id: record.event_id,
        project_id: record.core.project_id
      },
      encodeStoredSemanticEvent(record),
      decodeStoredSemanticEvent
    );
    return Object.freeze({ status, id: record.event_id, value: record });
  }

  async ingestControlEvent(
    value: ControlEventRecord
  ): Promise<CollaborationPutResult<ControlEventId, ControlEventRecord>> {
    const record = parseControlEventRecordStructure(value);
    const identity = await deriveControlEventCoreIdentity(record.core);
    if (identity.id !== record.control_event_id) {
      throw new CollaborationStoreError(
        "mismatched",
        "Control event record ID does not match its canonical core."
      );
    }
    const status = await this.#putRecord(
      {
        kind: "control-event",
        id: record.control_event_id,
        project_id: record.core.project_id
      },
      encodeStoredControlEvent(record),
      decodeStoredControlEvent
    );
    return Object.freeze({ status, id: record.control_event_id, value: record });
  }

  async getSemanticPayload(
    id: SemanticPayloadId
  ): Promise<CollaborationReadResult<SemanticPayloadRecord>> {
    return this.#getRecord(
      "semantic-payload",
      parseDigestId("semantic-payload", id),
      decodeStoredSemanticPayload
    );
  }

  async getControlAction(
    id: ControlActionId
  ): Promise<CollaborationReadResult<ControlActionRecord>> {
    return this.#getRecord(
      "control-action",
      parseDigestId("control-action", id),
      decodeStoredControlAction
    );
  }

  async getSemanticEvent(
    id: SemanticEventId
  ): Promise<CollaborationReadResult<SemanticEventRecord>> {
    return this.#getRecord(
      "semantic-event",
      parseDigestId("semantic-event", id),
      decodeStoredSemanticEvent
    );
  }

  async getControlEvent(
    id: ControlEventId
  ): Promise<CollaborationReadResult<ControlEventRecord>> {
    return this.#getRecord(
      "control-event",
      parseDigestId("control-event", id),
      decodeStoredControlEvent
    );
  }

  async getAttestation(
    id: AttestationId
  ): Promise<CollaborationReadResult<AttestationRecord>> {
    return this.#getRecord(
      "attestation",
      parseDigestId("attestation", id),
      decodeStoredAttestation
    );
  }

  async scan<TKind extends CollaborationEventObjectKind>(
    kind: TKind
  ): Promise<readonly EventObjectScanEntry<TKind>[]> {
    const addresses = await this.#list(collaborationStoragePrefixes.commits);
    const entries: EventObjectScanEntry<TKind>[] = [];
    for (const address of addresses) {
      let addressed;
      try {
        addressed = objectIdFromStorageAddress(address);
      } catch {
        continue;
      }
      if (!addressed || addressed.kind !== kind) continue;
      const raw = await this.#readStoredObject(kind, addressed.id as never);
      const project = raw.marker?.project_id ?? null;
      const result = await this.#getRecord(
        kind,
        addressed.id as never,
        decoderForKind(kind) as never
      );
      entries.push(Object.freeze({
        kind,
        id: addressed.id as CollaborationObjectIdByKind[TKind],
        project_id: project,
        result
      }) as EventObjectScanEntry<TKind>);
    }
    return Object.freeze(entries.sort((left, right) => left.id < right.id ? -1 : 1));
  }

  async recover(): Promise<EventObjectRecoveryReport> {
    await this.#failureInjector?.(Object.freeze({ stage: "during_recovery" }));
    const valid: string[] = [];
    const incomplete: CollaborationStorageAddress[] = [];
    const corrupted: string[] = [];
    const mismatched: string[] = [];
    const cleaned: CollaborationStorageAddress[] = [];
    const invalid: string[] = [];

    const commits = await this.#list(collaborationStoragePrefixes.commits);
    const commitSet = new Set(commits);
    for (const address of commits) {
      let addressed;
      try {
        addressed = objectIdFromStorageAddress(address);
      } catch {
        invalid.push(address);
        continue;
      }
      if (!addressed || !isEventKind(addressed.kind)) continue;
      const result = await this.#getRecord(
        addressed.kind,
        addressed.id as never,
        decoderForKind(addressed.kind) as never
      );
      if (result.status === "valid") valid.push(addressed.id);
      else if (result.status === "missing" || result.status === "incomplete") {
        incomplete.push(address);
      } else if (result.status === "corrupted") corrupted.push(addressed.id);
      else mismatched.push(addressed.id);
    }

    const dataAddresses = await this.#list(collaborationStoragePrefixes.data);
    for (const address of dataAddresses) {
      let addressed;
      try {
        addressed = objectIdFromStorageAddress(address);
      } catch {
        invalid.push(address);
        continue;
      }
      if (!addressed || !isEventKind(addressed.kind)) continue;
      const commit = collaborationObjectAddresses(
        addressed.kind,
        addressed.id as never
      ).commit;
      if (!commitSet.has(commit)) incomplete.push(address);
    }

    const staging = await this.#list(collaborationStoragePrefixes.staging);
    for (const address of staging) {
      let addressed;
      try {
        addressed = objectIdFromStorageAddress(address);
      } catch {
        invalid.push(address);
        continue;
      }
      if (!addressed || !isEventKind(addressed.kind)) continue;
      incomplete.push(address);
      await this.#delete(address);
      cleaned.push(address);
    }

    return Object.freeze({
      valid_object_ids: frozenSortedUnique(valid) as EventObjectRecoveryReport["valid_object_ids"],
      incomplete_addresses: frozenSortedUnique(incomplete),
      corrupted_object_ids: frozenSortedUnique(corrupted),
      mismatched_object_ids: frozenSortedUnique(mismatched),
      cleaned_staging_addresses: frozenSortedUnique(cleaned),
      invalid_addresses: frozenSortedUnique(invalid)
    });
  }

  async #putRecord<TKind extends CollaborationEventObjectKind>(
    metadata: EventObjectMetadata<TKind>,
    bytes: Uint8Array,
    decode: (bytes: Uint8Array) => Promise<EventObjectRecordByKind[TKind]>
  ): Promise<"stored" | "already_present"> {
    return this.#withLock(`object:${metadata.kind}:${metadata.id}`, async () => {
      const existing = await this.#readStoredObject(metadata.kind, metadata.id);
      if (existing.status === "valid") {
        if (
          existing.marker.project_id !== metadata.project_id ||
          !bytesEqual(existing.bytes, bytes)
        ) {
          throw new CollaborationStoreError(
            "mismatched",
            "An immutable event-object address already contains different content."
          );
        }
        await decode(existing.bytes);
        return "already_present";
      }
      if (existing.status === "corrupted" || existing.status === "mismatched") {
        throw new CollaborationStoreError(existing.status, existing.reason);
      }

      const addresses = collaborationObjectAddresses(metadata.kind, metadata.id);
      await this.#failureInjector?.(Object.freeze({
        stage: "before_first_write",
        object_kind: metadata.kind,
        object_id: metadata.id
      }));
      await this.#write(addresses.staging, bytes, "staging");
      await this.#failureInjector?.(Object.freeze({
        stage: "after_write_before_verification",
        object_kind: metadata.kind,
        object_id: metadata.id
      }));
      const staged = await this.#read(addresses.staging);
      if (!staged || !bytesEqual(staged, bytes)) {
        throw new CollaborationStoreError(
          "incomplete",
          "Staged event-object bytes were incomplete after writing."
        );
      }
      await decode(staged);
      await this.#failureInjector?.(Object.freeze({
        stage: "after_verification_before_committed_visibility",
        object_kind: metadata.kind,
        object_id: metadata.id
      }));
      await this.#write(addresses.data, bytes, "object_data");
      const installed = await this.#read(addresses.data);
      if (!installed || !bytesEqual(installed, bytes)) {
        throw new CollaborationStoreError(
          "incomplete",
          "Installed event-object bytes were incomplete."
        );
      }
      await decode(installed);
      const marker = await encodeCommitMarker(metadata, installed);
      await this.#write(addresses.commit, marker, "commit_marker");
      const committedMarker = await this.#read(addresses.commit);
      if (!committedMarker || !bytesEqual(committedMarker, marker)) {
        throw new CollaborationStoreError(
          "incomplete",
          "Event-object commit marker was incomplete."
        );
      }
      await this.#delete(addresses.staging);
      const committed = await this.#readStoredObject(metadata.kind, metadata.id);
      if (committed.status !== "valid") throw readFailureError(committed);
      return "stored";
    });
  }

  async #getRecord<TKind extends CollaborationEventObjectKind>(
    kind: TKind,
    id: CollaborationObjectIdByKind[TKind],
    decode: (bytes: Uint8Array) => Promise<EventObjectRecordByKind[TKind]>
  ): Promise<CollaborationReadResult<EventObjectRecordByKind[TKind]>> {
    const stored = await this.#readStoredObject(kind, id);
    if (stored.status !== "valid") return stored;
    let record: EventObjectRecordByKind[TKind];
    try {
      record = await decode(stored.bytes);
    } catch (error) {
      return failure("corrupted", errorMessage(error));
    }
    const recordProject = projectIdForRecord(kind, record);
    if (recordProject !== stored.marker.project_id) {
      return failure("mismatched", "Event-object commit metadata has incorrect ownership.");
    }
    const recordId = idForRecord(kind, record);
    if (recordId !== id) {
      return failure("mismatched", "Event object is stored under the wrong digest ID.");
    }
    return Object.freeze({ status: "valid" as const, value: copyRecord(kind, record) });
  }

  async #readStoredObject<TKind extends CollaborationEventObjectKind>(
    kind: TKind,
    id: CollaborationObjectIdByKind[TKind]
  ): Promise<RawStoredRead> {
    const addresses = collaborationObjectAddresses(kind, id);
    const markerBytes = await this.#read(addresses.commit);
    const data = await this.#read(addresses.data);
    const staged = await this.#read(addresses.staging);
    if (markerBytes === null) {
      if (data !== null || staged !== null) {
        return failure("incomplete", "Object data exists without committed visibility.");
      }
      return failure("missing", "Object was not found.");
    }
    let marker: ParsedCommitMarker;
    try {
      marker = parseCommitMarker(markerBytes);
    } catch (error) {
      if (isTruncatedCommitMarker(markerBytes)) {
        return failure("incomplete", "Object commit marker is truncated.");
      }
      return failure("corrupted", errorMessage(error));
    }
    if (marker.kind !== kind || marker.id !== id) {
      return { ...failure("mismatched", "Object commit marker does not match its address."), marker };
    }
    if (data === null) {
      return { ...failure("incomplete", "Committed object data is missing."), marker };
    }
    if (data.length !== marker.stored_byte_length) {
      return { ...failure("corrupted", "Committed object byte length does not match its marker."), marker };
    }
    const digest = bytesToHex(await sha256(data));
    if (digest !== marker.stored_sha256) {
      return { ...failure("corrupted", "Committed object bytes fail their storage digest."), marker };
    }
    return Object.freeze({
      status: "valid" as const,
      bytes: Uint8Array.from(data),
      marker
    });
  }

  async #read(address: CollaborationStorageAddress): Promise<Uint8Array | null> {
    try {
      const result = await this.#backend.read(address);
      if (result !== null && !(result instanceof Uint8Array)) {
        throw new Error("Byte backend returned a non-byte value.");
      }
      return result === null ? null : Uint8Array.from(result);
    } catch (error) {
      throw backendError("read", address, error);
    }
  }

  async #write(
    address: CollaborationStorageAddress,
    bytes: Uint8Array,
    stage: "staging" | "object_data" | "commit_marker"
  ): Promise<void> {
    try {
      await this.#backend.write(address, Uint8Array.from(bytes), { stage });
    } catch (error) {
      throw backendError("write", address, error);
    }
  }

  async #delete(address: CollaborationStorageAddress): Promise<void> {
    try {
      await this.#backend.delete(address);
    } catch (error) {
      throw backendError("delete", address, error);
    }
  }

  async #list(prefix: CollaborationStoragePrefix): Promise<readonly CollaborationStorageAddress[]> {
    try {
      const result = await this.#backend.list(prefix);
      if (!Array.isArray(result)) throw new Error("Byte backend list must return an array.");
      return Object.freeze([...result]);
    } catch (error) {
      throw backendError("list", prefix, error);
    }
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.#locks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

async function encodeCommitMarker<TKind extends CollaborationEventObjectKind>(
  metadata: EventObjectMetadata<TKind>,
  data: Uint8Array
): Promise<Uint8Array> {
  return new TextEncoder().encode(
    `${commitHeader}\n` +
      `kind=${metadata.kind}\n` +
      `id=${metadata.id}\n` +
      `project_id=${metadata.project_id}\n` +
      `document_id=-\n` +
      `stored_byte_length=${data.length}\n` +
      `stored_sha256=${bytesToHex(await sha256(data))}\n`
  );
}

function parseCommitMarker(bytes: Uint8Array): ParsedCommitMarker {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Object commit marker is not well-formed UTF-8.");
  }
  const lines = text.split("\n");
  if (lines.length !== 8 || lines[0] !== commitHeader || lines[7] !== "") {
    throw new Error("Object commit marker has an invalid envelope.");
  }
  const kindText = markerValue(lines[1], "kind");
  if (!isEventKind(kindText)) {
    throw new Error("Object commit marker has an unsupported event-object kind.");
  }
  const id = parseCollaborationObjectId(kindText, markerValue(lines[2], "id"));
  const projectId = parseEntityId("project", markerValue(lines[3], "project_id"));
  if (markerValue(lines[4], "document_id") !== "-") {
    throw new Error("Event-object commit markers cannot declare a document owner.");
  }
  const lengthText = markerValue(lines[5], "stored_byte_length");
  if (!/^(?:0|[1-9][0-9]*)$/.test(lengthText)) {
    throw new Error("Object commit marker has an invalid byte length.");
  }
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length)) {
    throw new Error("Object commit marker byte length exceeds the runtime range.");
  }
  const digest = markerValue(lines[6], "stored_sha256");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Object commit marker has an invalid storage digest.");
  }
  return Object.freeze({
    kind: kindText,
    id,
    project_id: projectId,
    stored_byte_length: length,
    stored_sha256: digest
  });
}

function markerValue(line: string, key: string): string {
  const prefix = `${key}=`;
  if (!line.startsWith(prefix) || line.length === prefix.length) {
    throw new Error(`Object commit marker is missing ${key}.`);
  }
  return line.slice(prefix.length);
}

function isTruncatedCommitMarker(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return `${commitHeader}\n`.startsWith(text) ||
      (text.startsWith(`${commitHeader}\n`) && text.split("\n").length < 8);
  } catch {
    return false;
  }
}

function isEventKind(value: string): value is CollaborationEventObjectKind {
  return value === "semantic-payload" ||
    value === "control-action" ||
    value === "semantic-event" ||
    value === "control-event" ||
    value === "attestation";
}

function decoderForKind<TKind extends CollaborationEventObjectKind>(
  kind: TKind
): (bytes: Uint8Array) => Promise<EventObjectRecordByKind[TKind]> {
  switch (kind) {
    case "semantic-payload":
      return decodeStoredSemanticPayload as never;
    case "control-action":
      return decodeStoredControlAction as never;
    case "semantic-event":
      return decodeStoredSemanticEvent as never;
    case "control-event":
      return decodeStoredControlEvent as never;
    case "attestation":
      return decodeStoredAttestation as never;
  }
}

function projectIdForRecord<TKind extends CollaborationEventObjectKind>(
  kind: TKind,
  record: EventObjectRecordByKind[TKind]
): ProjectId {
  switch (kind) {
    case "semantic-payload":
    case "control-action":
      return (record as SemanticPayloadRecord | ControlActionRecord).core.project_id;
    case "semantic-event":
      return (record as SemanticEventRecord).core.project_id;
    case "control-event":
      return (record as ControlEventRecord).core.project_id;
    case "attestation":
      return (record as AttestationRecord).core.project_id;
  }
}

function idForRecord<TKind extends CollaborationEventObjectKind>(
  kind: TKind,
  record: EventObjectRecordByKind[TKind]
): string {
  switch (kind) {
    case "semantic-payload":
      return (record as SemanticPayloadRecord).payload_id;
    case "control-action":
      return (record as ControlActionRecord).action_id;
    case "semantic-event":
      return (record as SemanticEventRecord).event_id;
    case "control-event":
      return (record as ControlEventRecord).control_event_id;
    case "attestation":
      return (record as AttestationRecord).attestation_id;
  }
}

function copyRecord<TKind extends CollaborationEventObjectKind>(
  kind: TKind,
  record: EventObjectRecordByKind[TKind]
): EventObjectRecordByKind[TKind] {
  return (kind === "attestation"
    ? copyAttestation(record as AttestationRecord)
    : record) as EventObjectRecordByKind[TKind];
}

function copyAttestation(value: AttestationRecord): AttestationRecord {
  return Object.freeze({
    ...value,
    core: Object.freeze({
      ...value.core,
      signature_bytes: Uint8Array.from(value.core.signature_bytes)
    })
  });
}

function failure<TStatus extends string>(status: TStatus, reason: string) {
  return Object.freeze({ status, reason });
}

function readFailureError(
  result: Readonly<{ status: string; reason: string }>
): CollaborationStoreError {
  const code = result.status === "missing"
    ? "not_found"
    : result.status === "incomplete"
      ? "incomplete"
      : result.status === "mismatched"
        ? "mismatched"
        : "corrupted";
  return new CollaborationStoreError(code, result.reason);
}

function backendError(operation: string, address: string, cause: unknown) {
  return new CollaborationStoreError(
    "backend_failed",
    `Collaboration byte backend failed to ${operation} ${address}.`,
    cause
  );
}

function frozenSortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

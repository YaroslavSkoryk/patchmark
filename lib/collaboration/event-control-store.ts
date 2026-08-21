import { bytesEqual } from "./bytes.ts";
import type { AttestationCore, AttestationRecord } from "./checkpoints.ts";
import {
  parseControlEventRecord,
  parseControlEventRecordStructure,
  type ControlActionCore,
  type ControlEventRecord
} from "./control.ts";
import {
  decodeSemanticSequenceReservation,
  encodeEventControlProjectState,
  encodeSemanticSequenceReservation,
  parseSemanticSequenceReservation,
  verifyEventControlProjectStateEncoding
} from "./event-control-indexes.ts";
import {
  reconstructEventControlProject,
  type ReconstructedEventControlProject
} from "./event-control-reconstruction.ts";
import type {
  CollaborationAttestationVerifier,
  CollaborationControlTransitionVerifier,
  EventControlProjectState,
  LocalSemanticAppendRequest,
  LocalSemanticAppendResult,
  SemanticSequenceReservation,
  Slice4FailureInjector
} from "./event-control-types.ts";
import {
  ImmutableEventObjectStore,
  type EventObjectScanEntry
} from "./event-object-store.ts";
import {
  decodeStoredAttestation,
  decodeStoredSemanticEvent,
  encodeStoredAttestation,
  encodeStoredSemanticEvent
} from "./event-storage-codec.ts";
import {
  parseDigestId,
  parseEntityId,
  type ControlEventId,
  type DeviceId,
  type ProjectId,
  type SemanticEventId
} from "./identities.ts";
import { ImmutableCollaborationStore } from "./immutable-store.ts";
import {
  buildSignaturePreimage,
  deriveSemanticEventCoreIdentity
} from "./preimages.ts";
import {
  parseSemanticEventCoreStructure,
  parseSemanticEventRecord,
  parseSemanticEventRecordStructure,
  type SemanticEventRecord,
  type SemanticPayloadCore
} from "./semantic.ts";
import {
  CollaborationStoreError,
  collaborationEventControlStateIndexAddress,
  collaborationSemanticReservationAddress,
  collaborationStoragePrefixes,
  parseCollaborationStorageAddress,
  type CollaborationByteStorageBackend,
  type CollaborationPutResult,
  type CollaborationReadResult,
  type CollaborationStorageAddress,
  type CollaborationStoragePrefix,
  type CollaborationStoreFailureInjector
} from "./storage.ts";
import { encodeCanonicalCbor } from "./canonical-cbor.ts";
import {
  expectUInt64,
  type UInt64
} from "./validation.ts";

export type IngestedSemanticEvent = Readonly<{
  object: CollaborationPutResult<SemanticEventId, SemanticEventRecord>;
  state: EventControlProjectState;
}>;

export type IngestedControlEvent = Readonly<{
  object: CollaborationPutResult<ControlEventId, ControlEventRecord>;
  state: EventControlProjectState;
}>;

type ReservationReadResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "valid"; value: SemanticSequenceReservation }>
  | Readonly<{ status: "corrupted"; reason: string }>;

type ReservationSnapshot = Readonly<{
  valid: readonly SemanticSequenceReservation[];
  invalid_addresses: readonly string[];
}>;

type ProjectObjectSnapshot = Readonly<{
  payloads: Map<string, import("./semantic.ts").SemanticPayloadRecord>;
  actions: Map<string, import("./control.ts").ControlActionRecord>;
  semantic_events: Map<string, SemanticEventRecord>;
  control_events: Map<string, ControlEventRecord>;
  attestations: Map<string, AttestationRecord>;
  invalid_ids: string[];
}>;

export class EventControlStore {
  readonly #backend: CollaborationByteStorageBackend;
  readonly #objects: ImmutableEventObjectStore;
  readonly #revisions: ImmutableCollaborationStore;
  readonly #attestationVerifier: CollaborationAttestationVerifier;
  readonly #transitionVerifier: CollaborationControlTransitionVerifier;
  readonly #failureInjector?: Slice4FailureInjector;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: Readonly<{
    backend: CollaborationByteStorageBackend;
    attestation_verifier: CollaborationAttestationVerifier;
    control_transition_verifier: CollaborationControlTransitionVerifier;
    object_failure_injector?: CollaborationStoreFailureInjector;
    failure_injector?: Slice4FailureInjector;
  }>) {
    if (!options || typeof options.backend !== "object" || options.backend === null) {
      throw new Error("Event/control storage requires an injected byte backend.");
    }
    if (!options.attestation_verifier || typeof options.attestation_verifier.verify !== "function") {
      throw new Error("Event/control storage requires a bound attestation verifier.");
    }
    if (
      !options.control_transition_verifier ||
      typeof options.control_transition_verifier.verify !== "function"
    ) {
      throw new Error("Event/control storage requires a bound control-transition verifier.");
    }
    this.#backend = options.backend;
    this.#attestationVerifier = options.attestation_verifier;
    this.#transitionVerifier = options.control_transition_verifier;
    this.#failureInjector = options.failure_injector;
    this.#objects = new ImmutableEventObjectStore({
      backend: options.backend,
      ...(options.object_failure_injector
        ? { failure_injector: options.object_failure_injector }
        : {})
    });
    this.#revisions = new ImmutableCollaborationStore({ backend: options.backend });
  }

  get immutableObjects(): ImmutableEventObjectStore {
    return this.#objects;
  }

  async putSemanticPayload(value: SemanticPayloadCore) {
    return this.#objects.putSemanticPayload(value);
  }

  async putControlAction(value: ControlActionCore) {
    return this.#objects.putControlAction(value);
  }

  async putAttestationCore(value: AttestationCore) {
    return this.#objects.putAttestationCore(value);
  }

  async putAttestationRecord(value: AttestationRecord) {
    return this.#objects.putAttestationRecord(value);
  }

  async ingestSemanticEvent(value: SemanticEventRecord): Promise<IngestedSemanticEvent> {
    const stored = await this.#objects.ingestSemanticEvent(value);
    const reconstructed = await this.#reconstruct(stored.value.core.project_id, true);
    return Object.freeze({ object: stored, state: reconstructed.state });
  }

  async putSemanticEvent(value: SemanticEventRecord): Promise<IngestedSemanticEvent> {
    const structural = parseSemanticEventRecordStructure(value);
    const payload = await this.#objects.getSemanticPayload(
      structural.core.semantic_payload_id
    );
    if (payload.status !== "valid") throw readFailureError(payload);
    const record = parseSemanticEventRecord(structural, payload.value);
    for (const attestationId of record.author_attestation_ids) {
      const attestation = await this.#objects.getAttestation(attestationId);
      if (attestation.status !== "valid") throw readFailureError(attestation);
    }
    return this.ingestSemanticEvent(record);
  }

  async ingestControlEvent(value: ControlEventRecord): Promise<IngestedControlEvent> {
    const stored = await this.#objects.ingestControlEvent(value);
    const reconstructed = await this.#reconstruct(stored.value.core.project_id, true);
    return Object.freeze({ object: stored, state: reconstructed.state });
  }

  async putControlEvent(value: ControlEventRecord): Promise<IngestedControlEvent> {
    const structural = parseControlEventRecordStructure(value);
    const attestation = await this.#objects.getAttestation(
      structural.authority_attestation_id
    );
    if (attestation.status !== "valid") throw readFailureError(attestation);
    if (structural.core.control_kind === "genesis") {
      return this.ingestControlEvent(parseControlEventRecord(structural));
    }
    const action = await this.#objects.getControlAction(structural.core.action_id);
    if (action.status !== "valid") throw readFailureError(action);
    if (structural.core.control_kind === "root_recovery") {
      return this.ingestControlEvent(
        parseControlEventRecord(structural, { action: action.value })
      );
    }
    const reconstructed = await this.#reconstruct(structural.core.project_id, false);
    const authority = reconstructed.control_authorities.get(
      structural.core.previous_control_id
    );
    const previous = await this.#objects.getControlEvent(
      structural.core.previous_control_id
    );
    if (!authority || previous.status !== "valid") {
      throw new CollaborationStoreError(
        "dependency_missing",
        "Strict control insertion requires an accepted previous control head."
      );
    }
    return this.ingestControlEvent(
      parseControlEventRecord(structural, {
        action: action.value,
        ordinary_context: {
          expected_previous_control_id: previous.value.control_event_id,
          expected_control_sequence: nextUInt64(
            previous.value.core.control_sequence,
            "strict control insertion sequence"
          ),
          designated_active_control_device_id: authority.active_control_device_id,
          expected_project_id: structural.core.project_id
        }
      })
    );
  }

  async reconstructProject(projectId: ProjectId): Promise<EventControlProjectState> {
    return (await this.#reconstruct(parseEntityId("project", projectId), true)).state;
  }

  async reopenProject(projectId: ProjectId): Promise<EventControlProjectState> {
    const project = parseEntityId("project", projectId);
    await this.#injectFailure({ stage: "during_reopening", project_id: project });
    await this.#objects.recover();
    const reservations = await this.#reservationSnapshot(project);
    for (const reservation of reservations.valid) {
      if (reservation.reservation_state !== "pending") continue;
      await this.#completeReservation(reservation, false);
    }
    return (await this.#reconstruct(project, true)).state;
  }

  async appendLocalSemanticEvent(
    requestValue: LocalSemanticAppendRequest
  ): Promise<LocalSemanticAppendResult> {
    const request = parseLocalAppendRequest(requestValue);
    return this.#withLock(
      `append:${request.project_id}:${request.author_device_id}`,
      async () => {
        const existingReservation = await this.#readReservation(
          request.project_id,
          request.author_device_id
        );
        if (existingReservation.status === "corrupted") {
          throw new CollaborationStoreError(
            "chain_blocked",
            `Local device sequence reservation is corrupted: ${existingReservation.reason}`
          );
        }
        if (existingReservation.status === "valid") {
          const reservedEvent = await decodeStoredSemanticEvent(
            existingReservation.value.event_record_bytes
          );
          if (requestMatchesReservation(request, existingReservation.value, reservedEvent)) {
            const attestations = await decodeReservationAttestations(
              existingReservation.value
            );
            if (existingReservation.value.reservation_state === "pending") {
              await this.#completeReservation(existingReservation.value, true);
              await this.#reconstruct(request.project_id, true);
              return Object.freeze({
                status: "resumed" as const,
                event: reservedEvent,
                attestations
              });
            }
            const stored = await this.#objects.getSemanticEvent(reservedEvent.event_id);
            if (stored.status !== "valid") {
              throw new CollaborationStoreError(
                "chain_blocked",
                "Committed sequence reservation does not have its exact immutable event."
              );
            }
            return Object.freeze({
              status: "already_committed" as const,
              event: stored.value,
              attestations
            });
          }
        }

        const reconstructed = await this.#reconstruct(request.project_id, false);
        if (existingReservation.status === "valid") {
          const priorId = existingReservation.value.resulting_event_id;
          if (!reconstructed.state.accepted_semantic_event_ids.includes(priorId)) {
            throw new CollaborationStoreError(
              "chain_blocked",
              "A committed local reservation is not accepted, so the device chain cannot advance."
            );
          }
        }
        const controlAuthority = reconstructed.control_authorities.get(
          request.authorizing_control_head_id
        );
        if (!controlAuthority) {
          throw new CollaborationStoreError(
            "dependency_missing",
            "Local semantic append requires an accepted authorizing control head."
          );
        }
        const author = controlAuthority.device_authorities.find(
          (fact) => fact.device_id === request.author_device_id && fact.status === "active"
        );
        if (!author) {
          throw new CollaborationStoreError(
            "dependency_invalid",
            "Local semantic author device is not active at the selected control head."
          );
        }
        if (controlAuthority.key_epoch_id !== request.key_epoch_id) {
          throw new CollaborationStoreError(
            "dependency_invalid",
            "Local semantic append selected the wrong control key epoch."
          );
        }
        const payload = await this.#objects.getSemanticPayload(request.semantic_payload_id);
        if (payload.status !== "valid") throw readFailureError(payload);
        if (
          payload.value.core.project_id !== request.project_id ||
          payload.value.core.semantic_kind !== request.semantic_kind
        ) {
          throw new CollaborationStoreError(
            "ownership_mismatch",
            "Local semantic payload project or kind does not match the append request."
          );
        }

        const semanticScan = await this.#objects.scan("semantic-event");
        const projectEvents = validProjectRecords(semanticScan, request.project_id);
        const acceptedSet = new Set(reconstructed.state.accepted_semantic_event_ids);
        const deviceEvents = projectEvents
          .filter((event) => event.core.author_device_id === request.author_device_id)
          .sort((left, right) => left.core.device_sequence < right.core.device_sequence ? -1 : 1);
        const acceptedDeviceEvents = deviceEvents.filter((event) => acceptedSet.has(event.event_id));
        const previous = acceptedDeviceEvents.at(-1) ?? null;
        const sequence = previous === null
          ? expectUInt64(BigInt(0), "first local semantic sequence")
          : nextUInt64(previous.core.device_sequence, "next local semantic sequence");
        if (
          deviceEvents.some((event) =>
            !acceptedSet.has(event.event_id) && event.core.device_sequence >= sequence
          )
        ) {
          throw new CollaborationStoreError(
            "chain_blocked",
            "An unresolved imported event occupies or exceeds the next local device sequence."
          );
        }

        const core = parseSemanticEventCoreStructure({
          schema_version: 1,
          object_kind: "semantic_event_core",
          device_chain_position: previous === null ? "first" : "subsequent",
          project_id: request.project_id,
          semantic_kind: request.semantic_kind,
          author_device_id: request.author_device_id,
          device_sequence: sequence,
          previous_device_event_id: previous?.event_id ?? null,
          causal_parent_event_ids: request.causal_parent_event_ids,
          authorizing_control_head_id: request.authorizing_control_head_id,
          key_epoch_id: request.key_epoch_id,
          semantic_payload_id: request.semantic_payload_id,
          complete_known_frontier: true,
          ...(request.display_timestamp === undefined
            ? {}
            : { display_timestamp: request.display_timestamp })
        });
        const identity = await deriveSemanticEventCoreIdentity(core);
        const signaturePreimage = encodeCanonicalCbor(
          buildSignaturePreimage(
            "semantic_event",
            request.project_id,
            identity.id
          )
        );
        const factoryRecords = await request.create_attestations(Object.freeze({
          project_id: request.project_id,
          event_id: identity.id,
          author_device_id: request.author_device_id,
          expected_person_id: author.person_id,
          expected_signing_key_id: author.signing_key_id,
          signature_preimage: Uint8Array.from(signaturePreimage)
        }));
        if (!Array.isArray(factoryRecords) || factoryRecords.length === 0) {
          throw new Error("Local semantic attestation factory must return at least one record.");
        }
        const attestations = [...factoryRecords].sort(
          (left, right) => left.attestation_id < right.attestation_id ? -1 : 1
        );
        for (const attestation of attestations) {
          if (
            attestation.core.project_id !== request.project_id ||
            attestation.core.subject_kind !== "semantic_event" ||
            attestation.core.subject_id !== identity.id ||
            attestation.core.signer_key_id !== author.signing_key_id
          ) {
            throw new Error("Local attestation factory returned an incorrectly bound record.");
          }
        }
        const event = parseSemanticEventRecordStructure({
          record_version: 1,
          object_kind: "semantic_event",
          event_id: identity.id,
          core,
          author_attestation_ids: attestations.map((entry) => entry.attestation_id)
        });
        const reservation = parseSemanticSequenceReservation({
          schema_version: 1,
          object_kind: "semantic_sequence_reservation",
          reservation_state: "pending",
          project_id: request.project_id,
          device_id: request.author_device_id,
          device_sequence: sequence,
          previous_device_event_id: previous?.event_id ?? null,
          semantic_payload_id: request.semantic_payload_id,
          causal_parent_event_ids: request.causal_parent_event_ids,
          authorizing_control_head_id: request.authorizing_control_head_id,
          key_epoch_id: request.key_epoch_id,
          resulting_event_id: identity.id,
          event_record_bytes: encodeStoredSemanticEvent(event),
          attestation_record_bytes: attestations.map(encodeStoredAttestation)
        });
        await this.#injectFailure({
          stage: "before_reservation_write",
          project_id: request.project_id,
          device_id: request.author_device_id,
          event_id: identity.id
        });
        await this.#writeReservation(reservation);
        await this.#completeReservation(reservation, true);
        await this.#reconstruct(request.project_id, true);
        return Object.freeze({
          status: "committed" as const,
          event,
          attestations: Object.freeze(attestations)
        });
      }
    );
  }

  async getSequenceReservation(
    projectId: ProjectId,
    deviceId: DeviceId
  ): Promise<ReservationReadResult> {
    return this.#readReservation(
      parseEntityId("project", projectId),
      parseEntityId("device", deviceId)
    );
  }

  async getProjectStateIndex(
    projectId: ProjectId
  ): Promise<CollaborationReadResult<Uint8Array>> {
    const project = parseEntityId("project", projectId);
    const address = collaborationEventControlStateIndexAddress(project);
    const bytes = await this.#read(address);
    if (bytes === null) return failure("missing", "Event/control project-state index was not found.");
    try {
      verifyEventControlProjectStateEncoding(bytes, project);
      return Object.freeze({ status: "valid" as const, value: Uint8Array.from(bytes) });
    } catch (error) {
      return failure("corrupted", errorMessage(error));
    }
  }

  async #completeReservation(
    reservation: SemanticSequenceReservation,
    injectFailures: boolean
  ): Promise<void> {
    if (injectFailures) {
      await this.#injectFailure({
        stage: "after_reservation_before_attestation_storage",
        project_id: reservation.project_id,
        device_id: reservation.device_id,
        event_id: reservation.resulting_event_id
      });
    }
    const attestations = await decodeReservationAttestations(reservation);
    for (const attestation of attestations) {
      await this.#objects.putAttestationRecord(attestation);
    }
    if (injectFailures) {
      await this.#injectFailure({
        stage: "after_attestation_storage_before_event_storage",
        project_id: reservation.project_id,
        device_id: reservation.device_id,
        event_id: reservation.resulting_event_id
      });
    }
    const event = await decodeStoredSemanticEvent(reservation.event_record_bytes);
    if (
      event.event_id !== reservation.resulting_event_id ||
      !requestFieldsMatchReservationEvent(reservation, event)
    ) {
      throw new CollaborationStoreError(
        "reservation_conflict",
        "Sequence reservation does not bind its exact stored semantic event."
      );
    }
    await this.#objects.ingestSemanticEvent(event);
    if (injectFailures) {
      await this.#injectFailure({
        stage: "after_event_commit_before_sequence_index_update",
        project_id: reservation.project_id,
        device_id: reservation.device_id,
        event_id: reservation.resulting_event_id
      });
    }
    await this.#writeReservation(Object.freeze({
      ...reservation,
      reservation_state: "committed" as const
    }));
  }

  async #reconstruct(
    project: ProjectId,
    persist: boolean
  ): Promise<ReconstructedEventControlProject> {
    const objects = await this.#projectObjectSnapshot(project);
    const reservations = await this.#reservationSnapshot(project);
    const reconstructed = await reconstructEventControlProject({
      project_id: project,
      payloads: objects.payloads,
      actions: objects.actions,
      semantic_events: objects.semantic_events,
      control_events: objects.control_events,
      attestations: objects.attestations,
      invalid_object_ids: [...objects.invalid_ids, ...reservations.invalid_addresses],
      pending_reservations: reservations.valid,
      revision_store: this.#revisions,
      attestation_verifier: this.#attestationVerifier,
      transition_verifier: this.#transitionVerifier
    });
    if (persist) await this.#writeProjectStateIndex(reconstructed.state);
    return reconstructed;
  }

  async #projectObjectSnapshot(project: ProjectId): Promise<ProjectObjectSnapshot> {
    const [payloadScan, actionScan, eventScan, controlScan, attestationScan] =
      await Promise.all([
        this.#objects.scan("semantic-payload"),
        this.#objects.scan("control-action"),
        this.#objects.scan("semantic-event"),
        this.#objects.scan("control-event"),
        this.#objects.scan("attestation")
      ]);
    const invalid: string[] = [];
    const payloads = recordsMap(payloadScan, project, invalid);
    const actions = recordsMap(actionScan, project, invalid);
    const events = recordsMap(eventScan, project, invalid);
    const controls = recordsMap(controlScan, project, invalid);
    const attestations = recordsMap(attestationScan, project, invalid);
    return {
      payloads: payloads as ProjectObjectSnapshot["payloads"],
      actions: actions as ProjectObjectSnapshot["actions"],
      semantic_events: events as ProjectObjectSnapshot["semantic_events"],
      control_events: controls as ProjectObjectSnapshot["control_events"],
      attestations: attestations as ProjectObjectSnapshot["attestations"],
      invalid_ids: invalid
    };
  }

  async #reservationSnapshot(project: ProjectId): Promise<ReservationSnapshot> {
    const addresses = await this.#list(collaborationStoragePrefixes.semanticReservations);
    const segment = `/${project.slice(project.lastIndexOf(":") + 1)}/`;
    const valid: SemanticSequenceReservation[] = [];
    const invalid: string[] = [];
    for (const address of addresses) {
      if (!address.includes(segment)) continue;
      const bytes = await this.#read(address);
      if (bytes === null) continue;
      try {
        const reservation = decodeSemanticSequenceReservation(bytes);
        if (reservation.project_id !== project) {
          invalid.push(address);
        } else {
          valid.push(reservation);
        }
      } catch {
        invalid.push(address);
      }
    }
    return Object.freeze({
      valid: Object.freeze(valid.sort((a, b) => a.device_id < b.device_id ? -1 : 1)),
      invalid_addresses: Object.freeze(invalid.sort())
    });
  }

  async #readReservation(
    project: ProjectId,
    device: DeviceId
  ): Promise<ReservationReadResult> {
    const address = collaborationSemanticReservationAddress(project, device);
    const bytes = await this.#read(address);
    if (bytes === null) return Object.freeze({ status: "missing" as const });
    try {
      const value = decodeSemanticSequenceReservation(bytes);
      if (value.project_id !== project || value.device_id !== device) {
        return failure("corrupted", "Sequence reservation ownership does not match its address.");
      }
      return Object.freeze({ status: "valid" as const, value });
    } catch (error) {
      return failure("corrupted", errorMessage(error));
    }
  }

  async #writeReservation(reservation: SemanticSequenceReservation): Promise<void> {
    const value = parseSemanticSequenceReservation(reservation);
    const address = collaborationSemanticReservationAddress(value.project_id, value.device_id);
    const bytes = encodeSemanticSequenceReservation(value);
    await this.#write(address, bytes, "sequence_reservation");
    const installed = await this.#read(address);
    if (!installed || !bytesEqual(installed, bytes)) {
      throw new CollaborationStoreError(
        "incomplete",
        "Semantic sequence reservation write was incomplete."
      );
    }
    decodeSemanticSequenceReservation(installed);
  }

  async #writeProjectStateIndex(state: EventControlProjectState): Promise<void> {
    const address = collaborationEventControlStateIndexAddress(state.project_id);
    const bytes = encodeEventControlProjectState(state);
    await this.#write(address, bytes, "derived_index");
    const installed = await this.#read(address);
    if (!installed || !bytesEqual(installed, bytes)) {
      throw new CollaborationStoreError("incomplete", "Event/control project-state index write was incomplete.");
    }
    verifyEventControlProjectStateEncoding(installed, state.project_id);
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
    stage: "derived_index" | "sequence_reservation"
  ): Promise<void> {
    try {
      await this.#backend.write(address, Uint8Array.from(bytes), { stage });
    } catch (error) {
      throw backendError("write", address, error);
    }
  }

  async #list(prefix: CollaborationStoragePrefix): Promise<readonly CollaborationStorageAddress[]> {
    try {
      const result = await this.#backend.list(prefix);
      if (!Array.isArray(result)) throw new Error("Byte backend list must return an array.");
      return Object.freeze(result.map((address) => parseCollaborationStorageAddress(address)));
    } catch (error) {
      throw backendError("list", prefix, error);
    }
  }

  async #injectFailure(context: Parameters<Slice4FailureInjector>[0]): Promise<void> {
    await this.#failureInjector?.(Object.freeze({ ...context }));
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

function parseLocalAppendRequest(value: LocalSemanticAppendRequest): LocalSemanticAppendRequest {
  if (!value || typeof value !== "object") throw new Error("Local append request must be structured.");
  if (value.complete_known_frontier !== true) {
    throw new Error("Local append requires a complete-known-frontier marker.");
  }
  if (typeof value.create_attestations !== "function") {
    throw new Error("Local append requires an attestation factory.");
  }
  const parents = value.causal_parent_event_ids.map((candidate) =>
    parseDigestId("semantic-event", candidate)
  );
  for (let index = 1; index < parents.length; index += 1) {
    if (parents[index - 1] >= parents[index]) {
      throw new Error("Local append causal parents must be strictly sorted and unique.");
    }
  }
  return Object.freeze({
    project_id: parseEntityId("project", value.project_id),
    author_device_id: parseEntityId("device", value.author_device_id),
    semantic_kind: value.semantic_kind,
    semantic_payload_id: parseDigestId("semantic-payload", value.semantic_payload_id),
    causal_parent_event_ids: Object.freeze(parents),
    authorizing_control_head_id: parseDigestId(
      "control-event",
      value.authorizing_control_head_id
    ),
    key_epoch_id: parseEntityId("key-epoch", value.key_epoch_id),
    complete_known_frontier: true,
    ...(value.display_timestamp === undefined
      ? {}
      : { display_timestamp: value.display_timestamp }),
    create_attestations: value.create_attestations
  });
}

function requestMatchesReservation(
  request: LocalSemanticAppendRequest,
  reservation: SemanticSequenceReservation,
  event: SemanticEventRecord
): boolean {
  return request.project_id === reservation.project_id &&
    request.author_device_id === reservation.device_id &&
    request.semantic_payload_id === reservation.semantic_payload_id &&
    request.authorizing_control_head_id === reservation.authorizing_control_head_id &&
    request.key_epoch_id === reservation.key_epoch_id &&
    sameStrings(request.causal_parent_event_ids, reservation.causal_parent_event_ids) &&
    event.core.semantic_kind === request.semantic_kind &&
    event.core.display_timestamp === request.display_timestamp;
}

function requestFieldsMatchReservationEvent(
  reservation: SemanticSequenceReservation,
  event: SemanticEventRecord
): boolean {
  return event.core.project_id === reservation.project_id &&
    event.core.author_device_id === reservation.device_id &&
    event.core.device_sequence === reservation.device_sequence &&
    event.core.previous_device_event_id === reservation.previous_device_event_id &&
    event.core.semantic_payload_id === reservation.semantic_payload_id &&
    event.core.authorizing_control_head_id === reservation.authorizing_control_head_id &&
    event.core.key_epoch_id === reservation.key_epoch_id &&
    sameStrings(event.core.causal_parent_event_ids, reservation.causal_parent_event_ids);
}

async function decodeReservationAttestations(
  reservation: SemanticSequenceReservation
): Promise<readonly AttestationRecord[]> {
  return Object.freeze(
    await Promise.all(
      reservation.attestation_record_bytes.map((bytes) => decodeStoredAttestation(bytes))
    )
  );
}

function validProjectRecords<TKind extends import("./storage.ts").CollaborationEventObjectKind>(
  entries: readonly EventObjectScanEntry<TKind>[],
  project: ProjectId
): Array<EventObjectScanEntry<TKind>["result"] extends CollaborationReadResult<infer T> ? T : never> {
  const result: unknown[] = [];
  for (const entry of entries) {
    if (entry.result.status === "valid" && entry.project_id === project) {
      result.push(entry.result.value);
    }
  }
  return result as never;
}

function recordsMap<TKind extends import("./storage.ts").CollaborationEventObjectKind>(
  entries: readonly EventObjectScanEntry<TKind>[],
  project: ProjectId,
  invalid: string[]
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry.result.status === "valid") {
      result.set(entry.id, entry.result.value);
    } else if (entry.project_id === project) {
      invalid.push(entry.id);
    }
  }
  return result;
}

function nextUInt64(value: UInt64, label: string): UInt64 {
  return expectUInt64(value + BigInt(1), label);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failure<TStatus extends string>(status: TStatus, reason: string) {
  return Object.freeze({ status, reason });
}

function readFailureError(
  result: Readonly<{ status: string; reason: string }>
): CollaborationStoreError {
  const code = result.status === "missing"
    ? "dependency_missing"
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

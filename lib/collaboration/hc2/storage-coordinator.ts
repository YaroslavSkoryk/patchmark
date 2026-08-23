import { bytesEqual } from "../bytes.ts";
import { parseEntityId, type DeviceId, type ProjectId } from "../identities.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectIdByKind,
  type CollaborationObjectKind
} from "../storage.ts";
import { hc2TransactionIntentAddress } from "./addresses.ts";
import type { Hc2CoordinationAdminStore } from "./coordination-store.ts";
import type { CompareAndAdvanceStreamInput, StreamCasFailureCode } from "./coordination.ts";
import {
  Hc2InjectedStorageFailure,
  type Hc2StorageFailureCut,
  type Hc2StorageFailureInjector
} from "./failure-injection.ts";
import {
  Hc2PortableFolderAdapter,
  Hc2PortableReplicaStore,
  encodeProtocolRecord,
  reconstructHc2Folder,
  type Hc2FolderReconstruction
} from "./portable-folder.ts";
import {
  deriveTransactionIntentCommitment,
  parsePortableBatchMarkerCore,
  parseTransactionIntentCore,
  type PortableBatchMarkerRecord,
  type TransactionIntentCore
} from "./records.ts";
import type { Hc2WebLocksAdapter } from "./web-locks.ts";

export type Hc2PortableMutationObject = {
  [TKind in CollaborationObjectKind]: Readonly<{
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_bytes: Uint8Array;
  }>;
}[CollaborationObjectKind];

export type Hc2PortableMutationResult =
  | Readonly<{ status: "committed"; batch_id: import("./identities.ts").PortableBatchId; reconstruction: Hc2FolderReconstruction; reservation_status: "advanced" | "already_committed_retry" | "idempotent_pending_retry"; finalization_status: "finalized" | "already_finalized" }>
  | Readonly<{ status: "read_only"; reason: "permission_denied" | "permission_prompt_required" | "replica_mismatch" | "key_continuity_missing" }>
  | Readonly<{ status: "reservation_failed"; code: StreamCasFailureCode }>
  | Readonly<{ status: "lock_failed" | "aborted"; reason: string }>
  | Readonly<{ status: "interrupted"; cut: Hc2StorageFailureCut }>
  | Readonly<{ status: "failed"; reason: string }>;

/** Explicit, time-independent coordinator for the frozen fourteen-step protocol. */
export class Hc2PortableMutationCoordinator {
  readonly #folder: Hc2PortableFolderAdapter;
  readonly #replica: Hc2PortableReplicaStore;
  readonly #coordination: Hc2CoordinationAdminStore;
  readonly #locks: Hc2WebLocksAdapter;

  constructor(options: Readonly<{
    folder: Hc2PortableFolderAdapter;
    replica: Hc2PortableReplicaStore;
    coordination: Hc2CoordinationAdminStore;
    locks: Hc2WebLocksAdapter;
  }>) {
    if (!options?.folder || !options.replica || !options.coordination || !options.locks) throw new Error("Portable mutation coordination requires all injected adapters.");
    this.#folder = options.folder;
    this.#replica = options.replica;
    this.#coordination = options.coordination;
    this.#locks = options.locks;
  }

  async commit(inputValue: Readonly<{
    project_id: ProjectId;
    device_id: DeviceId;
    key_continuity_confirmed: boolean;
    cas: CompareAndAdvanceStreamInput;
    transaction_intent: TransactionIntentCore;
    objects: readonly Hc2PortableMutationObject[];
    batch: PortableBatchMarkerRecord;
    signal?: AbortSignal;
    failure_injector?: Hc2StorageFailureInjector;
  }>): Promise<Hc2PortableMutationResult> {
    let input: ReturnType<typeof parseInput>;
    try { input = parseInput(inputValue); }
    catch (error) { return Object.freeze({ status: "failed", reason: safeErrorName(error) }); }
    try {
      const permission = await this.#folder.queryPermission("readwrite");
      if (permission === "denied") return Object.freeze({ status: "read_only", reason: "permission_denied" });
      if (permission !== "granted") return Object.freeze({ status: "read_only", reason: "permission_prompt_required" });
      const replicaMetadata = await this.#replica.readReplicaMetadata();
      if (!replicaMetadata || replicaMetadata.project_id !== input.project_id) return Object.freeze({ status: "read_only", reason: "replica_mismatch" });
      if (!input.key_continuity_confirmed) return Object.freeze({ status: "read_only", reason: "key_continuity_missing" });
      if (!(await verifyHc2IntentReservationBinding({ intent: input.transaction_intent, reservation: input.cas.reservation }))) {
        return Object.freeze({ status: "reservation_failed", code: "reservation_mismatch" });
      }
      await inject(input.failure_injector, "before_lock_acquisition", input.transaction_intent.operation_id);
    } catch (error) { return failureResult(error); }

    const locked = await this.#locks.runExclusive({
      project_id: input.project_id,
      device_id: input.device_id,
      signal: input.signal,
      operation: async () => {
        try {
          await inject(input.failure_injector, "after_lock_acquisition", input.transaction_intent.operation_id);
          await inject(input.failure_injector, "before_cas_reservation", input.transaction_intent.operation_id);
          const current = await this.#coordination.readDeviceStream(input.project_id, input.device_id);
          if (
            current?.continuity === "unambiguous" &&
            current.pending_reservation === null &&
            current.generation === input.cas.expected_generation + BigInt(1) &&
            current.allocated_sequence === input.cas.next_sequence &&
            current.allocated_object_id === input.cas.next_object_id
          ) {
            const alreadyVisible = await this.#replica.verifyCompleteBatch(input.batch);
            if (alreadyVisible.status !== "visible") throw new Error("IndexedDB is ahead of the exact portable batch marker.");
            const reconstruction = await reconstructHc2Folder(this.#replica);
            if (reconstruction.status !== "verified") throw new Error(`Portable retry reopen was ${reconstruction.status}.`);
            await this.#coordination.replaceVerifiedBatchCatalog(input.project_id, reconstruction.visible_batch_ids);
            return Object.freeze({
              status: "committed",
              batch_id: input.batch.batch_id,
              reconstruction,
              reservation_status: "already_committed_retry",
              finalization_status: "already_finalized"
            }) as Hc2PortableMutationResult;
          }
          const reserved = await this.#coordination.compareAndAdvanceStream(input.cas);
          if (reserved.status === "failed") return Object.freeze({ status: "reservation_failed", code: reserved.code }) as Hc2PortableMutationResult;
          await inject(input.failure_injector, "after_cas_reservation", input.transaction_intent.operation_id);
          await inject(input.failure_injector, "partial_transaction_intent_write", input.transaction_intent.operation_id);
          await inject(input.failure_injector, "permission_loss_transaction_intent", input.transaction_intent.operation_id);
          await this.#folder.write(hc2TransactionIntentAddress(input.transaction_intent.operation_id), encodeProtocolRecord(input.transaction_intent), "replace_operational");
          await inject(input.failure_injector, "complete_transaction_intent", input.transaction_intent.operation_id);
          const installedMarkerIds = new Map<CollaborationObjectId, string>();
          for (const object of input.objects) {
            const committed = await this.#replica.stageAndCommitObject({ ...object, project_id: input.project_id, failure_injector: input.failure_injector, allow_partial_repair_from_exact_reservation: true });
            installedMarkerIds.set(object.object_id, committed.marker_id);
          }
          for (const entry of input.batch.core.object_entries) {
            if (installedMarkerIds.get(entry.object_id) !== entry.object_commit_marker_id) throw new Error("Batch entry does not name the installed object commit marker.");
          }
          await this.#replica.commitBatch(input.batch, input.failure_injector, true);
          const visible = await this.#replica.verifyCompleteBatch(input.batch);
          if (visible.status !== "visible") throw new Error(`Committed batch failed visibility verification: ${visible.reason}.`);
          await inject(input.failure_injector, "after_folder_commit_before_indexeddb_finalization", input.transaction_intent.operation_id);
          await inject(input.failure_injector, "during_indexeddb_finalization", input.transaction_intent.operation_id);
          await inject(input.failure_injector, "indexeddb_quota_or_transaction_failure", input.transaction_intent.operation_id);
          const finalized = await this.#coordination.finalizeCommittedBatch({
            project_id: input.project_id,
            device_id: input.device_id,
            expected_generation: reserved.state.generation,
            reservation: input.cas.reservation,
            committed_batch_id: input.batch.batch_id
          });
          if (finalized.status === "failed") throw new Error(`IndexedDB finalization failed: ${finalized.code}.`);
          await inject(input.failure_injector, "after_indexeddb_finalization", input.transaction_intent.operation_id);
          await inject(input.failure_injector, "during_reopen", input.transaction_intent.operation_id);
          const reconstruction = await reconstructHc2Folder(this.#replica);
          if (reconstruction.status !== "verified") throw new Error(`Portable reopen was ${reconstruction.status}.`);
          await inject(input.failure_injector, "during_catalog_rebuilding", input.transaction_intent.operation_id);
          await this.#coordination.replaceVerifiedBatchCatalog(input.project_id, reconstruction.visible_batch_ids);
          return Object.freeze({
            status: "committed",
            batch_id: input.batch.batch_id,
            reconstruction,
            reservation_status: reserved.status,
            finalization_status: finalized.status
          }) as Hc2PortableMutationResult;
        } catch (error) { return failureResult(error); }
      }
    });
    if (locked.status === "completed") return locked.value;
    if (locked.status === "aborted") return Object.freeze({ status: "aborted", reason: locked.reason });
    return Object.freeze({ status: "lock_failed", reason: locked.reason });
  }
}

function parseInput(input: Readonly<{
  project_id: ProjectId;
  device_id: DeviceId;
  key_continuity_confirmed: boolean;
  cas: CompareAndAdvanceStreamInput;
  transaction_intent: TransactionIntentCore;
  objects: readonly Hc2PortableMutationObject[];
  batch: PortableBatchMarkerRecord;
  signal?: AbortSignal;
  failure_injector?: Hc2StorageFailureInjector;
}>) {
  const project = parseEntityId("project", input.project_id);
  const device = parseEntityId("device", input.device_id);
  if (typeof input.key_continuity_confirmed !== "boolean") throw new Error("Key continuity observation must be explicit.");
  if (input.cas.project_id !== project || input.cas.device_id !== device) throw new Error("CAS ownership does not match the mutation.");
  const intent = parseTransactionIntentCore(input.transaction_intent);
  const batch = Object.freeze({ core: parsePortableBatchMarkerCore(input.batch.core), batch_id: input.batch.batch_id });
  if (intent.project_id !== project || intent.device_id !== device || batch.core.project_id !== project || intent.intended_batch_id !== batch.batch_id) throw new Error("Intent or batch ownership does not match the mutation.");
  if (input.cas.reservation.intended_batch_id !== batch.batch_id) throw new Error("Reservation does not commit to the exact batch.");
  if (
    intent.expected_generation !== input.cas.expected_generation ||
    intent.expected_sequence !== input.cas.expected_sequence ||
    intent.expected_previous_object_id !== input.cas.expected_previous_object_id
  ) throw new Error("Transaction intent does not bind the exact expected stream head.");
  const objects = input.objects.map((object) => {
    const kind = parseCollaborationObjectKind(object.object_kind);
    const id = parseCollaborationObjectId(kind, object.object_id);
    if (!(object.exact_bytes instanceof Uint8Array)) throw new Error("Portable mutation objects require exact bytes.");
    return Object.freeze({ object_kind: kind, object_id: id, exact_bytes: Uint8Array.from(object.exact_bytes) }) as Hc2PortableMutationObject;
  });
  const plannedKeys = intent.planned_objects.map((entry) => `${entry.object_kind}\u0000${entry.object_id}`);
  const objectKeys = objects.map((entry) => `${entry.object_kind}\u0000${entry.object_id}`).sort();
  if (plannedKeys.length !== objectKeys.length || plannedKeys.some((key, index) => key !== objectKeys[index])) throw new Error("Transaction intent planned objects differ from supplied bytes.");
  const nextPlanned = intent.planned_objects.find((entry) => entry.object_id === input.cas.next_object_id);
  if (!nextPlanned || !bytesEqual(nextPlanned.signed_bytes_commitment, input.cas.reservation.exact_signed_bytes_commitment)) {
    throw new Error("Reservation does not bind the exact eventual signed object bytes.");
  }
  return Object.freeze({ ...input, project_id: project, device_id: device, transaction_intent: intent, objects: Object.freeze(objects), batch });
}

async function inject(injector: Hc2StorageFailureInjector | undefined, cut: Hc2StorageFailureCut, operationId?: string): Promise<void> {
  await injector?.inject(Object.freeze({ cut, operation_id: operationId }));
}

function failureResult(error: unknown): Hc2PortableMutationResult {
  return error instanceof Hc2InjectedStorageFailure
    ? Object.freeze({ status: "interrupted", cut: error.cut })
    : Object.freeze({ status: "failed", reason: safeErrorName(error) });
}

function safeErrorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "portable_mutation_failed";
}

/** Type-level proof that eventual intent bytes are commitment-bound before CAS. */
export async function verifyHc2IntentReservationBinding(input: Readonly<{
  intent: TransactionIntentCore;
  reservation: CompareAndAdvanceStreamInput["reservation"];
}>): Promise<boolean> {
  const identity = await deriveTransactionIntentCommitment(parseTransactionIntentCore(input.intent));
  return identity.commitment_id === input.reservation.transaction_intent_id;
}

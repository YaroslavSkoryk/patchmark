export const hc2StorageFailureCuts = Object.freeze([
  "before_lock_acquisition",
  "after_lock_acquisition",
  "before_cas_reservation",
  "after_cas_reservation",
  "partial_transaction_intent_write",
  "complete_transaction_intent",
  "partial_staging_write",
  "complete_staging_write",
  "after_staging_verification",
  "partial_final_object_write",
  "complete_final_object_write",
  "partial_object_commit_marker",
  "complete_object_commit_marker",
  "before_batch_marker_write",
  "partial_batch_marker_write",
  "complete_verified_batch_marker",
  "after_folder_commit_before_indexeddb_finalization",
  "during_indexeddb_finalization",
  "after_indexeddb_finalization",
  "during_reopen",
  "during_catalog_rebuilding",
  "permission_loss_transaction_intent",
  "permission_loss_staging",
  "permission_loss_final_object",
  "permission_loss_object_commit_marker",
  "permission_loss_batch_marker",
  "indexeddb_quota_or_transaction_failure",
  "opfs_failure_or_eviction"
] as const);

export type Hc2StorageFailureCut = (typeof hc2StorageFailureCuts)[number];

export type Hc2StorageFailureContext = Readonly<{
  cut: Hc2StorageFailureCut;
  operation_id?: string;
  object_id?: string;
}>;

export interface Hc2StorageFailureInjector {
  inject(context: Hc2StorageFailureContext): void | Promise<void>;
}

export class Hc2InjectedStorageFailure extends Error {
  readonly cut: Hc2StorageFailureCut;
  constructor(cut: Hc2StorageFailureCut) {
    super(`Injected HC-2 storage failure at ${cut}.`);
    this.name = "Hc2InjectedStorageFailure";
    this.cut = cut;
  }
}

/** Deterministic single-cut injector used only by tests and recovery models. */
export class Hc2SingleCutFailureInjector implements Hc2StorageFailureInjector {
  readonly #cut: Hc2StorageFailureCut;
  #observed = false;
  constructor(cut: Hc2StorageFailureCut) { this.#cut = parseHc2StorageFailureCut(cut); }
  inject(context: Hc2StorageFailureContext): void {
    if (context.cut === this.#cut && !this.#observed) {
      this.#observed = true;
      throw new Hc2InjectedStorageFailure(this.#cut);
    }
  }
  get observed(): boolean { return this.#observed; }
}

export function parseHc2StorageFailureCut(value: unknown): Hc2StorageFailureCut {
  if (typeof value !== "string" || !hc2StorageFailureCuts.includes(value as Hc2StorageFailureCut)) {
    throw new Error("Unknown HC-2 storage failure cut.");
  }
  return value as Hc2StorageFailureCut;
}

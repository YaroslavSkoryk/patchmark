export type Hc2StorageObservation = Readonly<{
  folder_read_permission: "denied" | "granted" | "prompt" | "unknown";
  folder_write_permission: "denied" | "granted" | "prompt" | "unknown";
  persistent_storage: "denied" | "granted" | "unknown";
  storage_estimate: "sufficient" | "low" | "unavailable";
  strict_reservation_transaction: "failed" | "supported" | "unknown";
  ephemeral_context: "detected" | "not_detected" | "unknown";
  opfs_cache_present: boolean;
}>;

export type Hc2StorageAdaptation = Readonly<{
  replica_mode: "blocked" | "verified_read_only" | "write_ready" | "write_ready_with_durability_warning";
  cache_action: "clear_first" | "ignore" | "retain";
  reason_codes: readonly (
    | "ephemeral_context"
    | "folder_read_permission_required"
    | "folder_write_permission_required"
    | "origin_quota_low"
    | "persistence_not_granted"
    | "reservation_transaction_required"
  )[];
}>;

/** Pure adaptation: optional origin storage can never invalidate folder bytes. */
export function evaluateHc2StorageAdaptation(observation: Hc2StorageObservation): Hc2StorageAdaptation {
  const reasons: Hc2StorageAdaptation["reason_codes"][number][] = [];
  const cacheAction = observation.storage_estimate === "low"
    ? "clear_first"
    : observation.opfs_cache_present ? "retain" : "ignore";
  if (observation.ephemeral_context === "detected") reasons.push("ephemeral_context");
  if (observation.folder_read_permission !== "granted") {
    reasons.push("folder_read_permission_required");
    return result("blocked", cacheAction, reasons);
  }
  if (observation.folder_write_permission !== "granted") reasons.push("folder_write_permission_required");
  if (observation.strict_reservation_transaction !== "supported") reasons.push("reservation_transaction_required");
  if (observation.storage_estimate === "low") reasons.push("origin_quota_low");
  if (reasons.length > 0) return result("verified_read_only", cacheAction, reasons);
  if (observation.persistent_storage !== "granted") {
    reasons.push("persistence_not_granted");
    return result("write_ready_with_durability_warning", cacheAction, reasons);
  }
  return result("write_ready", cacheAction, reasons);
}

function result(
  replicaMode: Hc2StorageAdaptation["replica_mode"],
  cacheAction: Hc2StorageAdaptation["cache_action"],
  reasons: Hc2StorageAdaptation["reason_codes"]
): Hc2StorageAdaptation {
  return Object.freeze({ replica_mode: replicaMode, cache_action: cacheAction, reason_codes: Object.freeze([...new Set(reasons)].sort()) });
}

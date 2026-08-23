import { HC2_ABSOLUTE_CHROMIUM_FLOOR, HC2_PLATFORM_POLICY_VERSION } from "./versions.ts";

export const platformPolicyReasonCodes = [
  "browser_state_recovery_required",
  "crypto_key_indexeddb_round_trip_unavailable",
  "ed25519_unavailable",
  "engine_family_unsupported",
  "engine_version_below_minimum",
  "file_system_access_unavailable",
  "folder_corrupt",
  "folder_unavailable",
  "folder_write_permission_required",
  "indexeddb_unavailable",
  "private_context_unsupported",
  "qualified_release_required",
  "recovery_kit_invalid",
  "recovery_kit_required",
  "secure_context_required",
  "storage_estimate_unavailable",
  "storage_persistence_denied",
  "storage_quota_insufficient",
  "strict_durability_unavailable",
  "top_level_context_required",
  "web_locks_unavailable",
  "x25519_unavailable"
] as const;

export type PlatformPolicyReasonCode = (typeof platformPolicyReasonCodes)[number];
export type CollaborationPlatformReadiness =
  | "write_ready"
  | "write_ready_with_durability_warning"
  | "verified_read_only"
  | "recovery_required"
  | "unsupported";

type CapabilityState = "available" | "unavailable" | "unknown";

export type CollaborationPlatformObservation = Readonly<{
  policy_version: typeof HC2_PLATFORM_POLICY_VERSION;
  engine_family: "chromium" | "other" | "unknown";
  engine_version: Readonly<{
    major: number;
    minor: number;
    build: number;
    patch: number;
  }> | null;
  qualified_release_window: "qualified" | "unqualified" | "unknown";
  secure_context: boolean;
  top_level_context: boolean;
  ed25519: CapabilityState;
  x25519: CapabilityState;
  crypto_key_indexeddb_round_trip: CapabilityState;
  indexeddb: CapabilityState;
  indexeddb_strict_durability: CapabilityState;
  web_locks: CapabilityState;
  file_system_access: CapabilityState;
  folder_state: "verified_writable" | "verified_read_only" | "unavailable" | "corrupt";
  folder_permission: "readwrite" | "read" | "prompt" | "denied" | "unknown";
  storage_estimate: "sufficient" | "insufficient" | "unavailable";
  persistent_storage: "granted" | "denied" | "unknown";
  private_context: "detected" | "not_detected" | "unknown";
  recovery_kit: "ready" | "missing" | "invalid";
  lifecycle: "initial_enablement" | "continuous_authoring" | "browser_state_missing_after_authoring";
}>;

export type CollaborationPlatformPolicyResult = Readonly<{
  policy_version: typeof HC2_PLATFORM_POLICY_VERSION;
  readiness: CollaborationPlatformReadiness;
  reason_codes: readonly PlatformPolicyReasonCode[];
}>;

export function evaluateCollaborationPlatformPolicy(
  value: CollaborationPlatformObservation
): CollaborationPlatformPolicyResult {
  const observation = parseCollaborationPlatformObservation(value);
  const unsupported: PlatformPolicyReasonCode[] = [];
  const recovery: PlatformPolicyReasonCode[] = [];
  const readOnly: PlatformPolicyReasonCode[] = [];
  const warnings: PlatformPolicyReasonCode[] = [];

  if (observation.engine_family !== "chromium") unsupported.push("engine_family_unsupported");
  if (
    observation.engine_version === null ||
    observation.engine_version.major < HC2_ABSOLUTE_CHROMIUM_FLOOR
  ) unsupported.push("engine_version_below_minimum");
  if (observation.qualified_release_window !== "qualified") {
    unsupported.push("qualified_release_required");
  }
  if (!observation.secure_context) unsupported.push("secure_context_required");
  if (!observation.top_level_context) unsupported.push("top_level_context_required");
  requireCapability(observation.ed25519, "ed25519_unavailable", unsupported);
  requireCapability(observation.x25519, "x25519_unavailable", unsupported);
  requireCapability(
    observation.crypto_key_indexeddb_round_trip,
    "crypto_key_indexeddb_round_trip_unavailable",
    unsupported
  );
  requireCapability(observation.indexeddb, "indexeddb_unavailable", unsupported);
  requireCapability(
    observation.indexeddb_strict_durability,
    "strict_durability_unavailable",
    unsupported
  );
  requireCapability(observation.web_locks, "web_locks_unavailable", unsupported);
  requireCapability(
    observation.file_system_access,
    "file_system_access_unavailable",
    unsupported
  );
  if (observation.private_context === "detected") {
    unsupported.push("private_context_unsupported");
  }
  if (observation.folder_state === "unavailable") unsupported.push("folder_unavailable");
  if (observation.folder_state === "corrupt") unsupported.push("folder_corrupt");
  if (observation.lifecycle === "initial_enablement") {
    if (observation.recovery_kit === "missing") unsupported.push("recovery_kit_required");
    if (observation.recovery_kit === "invalid") unsupported.push("recovery_kit_invalid");
  }

  if (unsupported.length > 0) return result("unsupported", unsupported);

  if (observation.lifecycle === "browser_state_missing_after_authoring") {
    recovery.push("browser_state_recovery_required");
  }
  if (recovery.length > 0) return result("recovery_required", recovery);

  if (
    observation.folder_state !== "verified_writable" ||
    observation.folder_permission !== "readwrite"
  ) readOnly.push("folder_write_permission_required");
  if (observation.storage_estimate === "insufficient") {
    readOnly.push("storage_quota_insufficient");
  }
  if (readOnly.length > 0) return result("verified_read_only", readOnly);

  if (observation.persistent_storage !== "granted") {
    warnings.push("storage_persistence_denied");
  }
  if (observation.storage_estimate === "unavailable") {
    warnings.push("storage_estimate_unavailable");
  }
  return warnings.length > 0
    ? result("write_ready_with_durability_warning", warnings)
    : result("write_ready", []);
}

export function parsePlatformPolicyReasonCode(value: unknown): PlatformPolicyReasonCode {
  if (typeof value !== "string" || !platformPolicyReasonCodes.includes(value as PlatformPolicyReasonCode)) {
    throw new Error("Unknown HC-2 platform policy reason code.");
  }
  return value as PlatformPolicyReasonCode;
}

export function parseCollaborationPlatformObservation(
  value: CollaborationPlatformObservation
): CollaborationPlatformObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Platform observation must be a record.");
  }
  const record = value as unknown as Record<string, unknown>;
  const exactKeys = [
    "policy_version", "engine_family", "engine_version", "qualified_release_window",
    "secure_context", "top_level_context", "ed25519", "x25519",
    "crypto_key_indexeddb_round_trip", "indexeddb", "indexeddb_strict_durability",
    "web_locks", "file_system_access", "folder_state", "folder_permission",
    "storage_estimate", "persistent_storage", "private_context", "recovery_kit", "lifecycle"
  ];
  assertExactKeys(record, exactKeys, "platform observation");
  if (record.policy_version !== HC2_PLATFORM_POLICY_VERSION) {
    throw new Error("Unknown HC-2 platform policy version.");
  }
  const engineVersion = parseEngineVersion(record.engine_version);
  assertEnum(record.engine_family, ["chromium", "other", "unknown"], "engine family");
  assertEnum(record.qualified_release_window, ["qualified", "unqualified", "unknown"], "release window");
  for (const key of ["ed25519", "x25519", "crypto_key_indexeddb_round_trip", "indexeddb", "indexeddb_strict_durability", "web_locks", "file_system_access"] as const) {
    assertEnum(record[key], ["available", "unavailable", "unknown"], key);
  }
  assertEnum(record.folder_state, ["verified_writable", "verified_read_only", "unavailable", "corrupt"], "folder state");
  assertEnum(record.folder_permission, ["readwrite", "read", "prompt", "denied", "unknown"], "folder permission");
  assertEnum(record.storage_estimate, ["sufficient", "insufficient", "unavailable"], "storage estimate");
  assertEnum(record.persistent_storage, ["granted", "denied", "unknown"], "persistent storage");
  assertEnum(record.private_context, ["detected", "not_detected", "unknown"], "private context");
  assertEnum(record.recovery_kit, ["ready", "missing", "invalid"], "recovery kit");
  assertEnum(record.lifecycle, ["initial_enablement", "continuous_authoring", "browser_state_missing_after_authoring"], "lifecycle");
  if (typeof record.secure_context !== "boolean" || typeof record.top_level_context !== "boolean") {
    throw new Error("Context capability states must be booleans.");
  }
  return Object.freeze({
    ...(record as unknown as CollaborationPlatformObservation),
    engine_version: engineVersion
  });
}

function parseEngineVersion(value: unknown): CollaborationPlatformObservation["engine_version"] {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Parsed engine version must be an exact four-part record or null.");
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ["major", "minor", "build", "patch"], "parsed engine version");
  for (const key of ["major", "minor", "build", "patch"] as const) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
      throw new Error(`Engine version ${key} must be a nonnegative safe integer.`);
    }
  }
  return Object.freeze({
    major: record.major as number,
    minor: record.minor as number,
    build: record.build as number,
    patch: record.patch as number
  });
}

function requireCapability(
  state: CapabilityState,
  code: PlatformPolicyReasonCode,
  reasons: PlatformPolicyReasonCode[]
): void {
  if (state !== "available") reasons.push(code);
}

function result(
  readiness: CollaborationPlatformReadiness,
  reasons: readonly PlatformPolicyReasonCode[]
): CollaborationPlatformPolicyResult {
  return Object.freeze({
    policy_version: HC2_PLATFORM_POLICY_VERSION,
    readiness,
    reason_codes: Object.freeze([...new Set(reasons)].sort())
  });
}

function assertEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} has an unsupported value.`);
  }
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly the versioned fields.`);
  }
}

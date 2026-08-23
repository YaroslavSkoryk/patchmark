import { HC2_RECOVERY_POLICY_VERSION } from "./versions.ts";

export type Hc2RecoveryReadiness =
  | "fully_ready"
  | "ready_with_persistence_warning"
  | "verified_read_only"
  | "folder_permission_required"
  | "recovery_kit_required"
  | "browser_state_recovery_required"
  | "new_device_enrollment_required"
  | "low_quota_read_only"
  | "unsupported_platform"
  | "corrupt_or_ambiguous_continuity"
  | "concurrent_profile_conflict";

export type Hc2RecoveryStateInput = Readonly<{
  policy_version: typeof HC2_RECOVERY_POLICY_VERSION;
  platform_supported: boolean;
  folder: "verified_writable" | "verified_read_only" | "permission_required" | "corrupt";
  recovery_kit: "ready" | "missing" | "invalid";
  browser_state: "continuous" | "catalog_missing" | "key_vault_missing" | "all_missing";
  key_vault_continuity: "unambiguous" | "ambiguous" | "absent";
  persistent_storage: "granted" | "denied" | "unknown";
  quota: "sufficient" | "low" | "unknown";
  opfs: "available" | "missing" | "unused";
  profile_state: "single_writer" | "conflicting_writer";
  lifecycle: "initial_enablement" | "existing_project" | "recovery_ceremony_complete";
}>;

export type Hc2RecoveryStateResult = Readonly<{
  policy_version: typeof HC2_RECOVERY_POLICY_VERSION;
  readiness: Hc2RecoveryReadiness;
  may_read_verified_plaintext: boolean;
  may_author: boolean;
  must_create_new_device: boolean;
  global_currency_claim: "not_permitted_offline";
}>;

export function evaluateHc2RecoveryReadiness(input: Hc2RecoveryStateInput): Hc2RecoveryStateResult {
  parseRecoveryStateInput(input);
  if (input.policy_version !== HC2_RECOVERY_POLICY_VERSION) {
    throw new Error("Unknown HC-2 recovery policy version.");
  }
  if (!input.platform_supported) return result("unsupported_platform", false, false, false);
  if (input.profile_state === "conflicting_writer") return result("concurrent_profile_conflict", true, false, false);
  if (input.folder === "corrupt" || input.key_vault_continuity === "ambiguous") {
    return result("corrupt_or_ambiguous_continuity", false, false, input.key_vault_continuity === "ambiguous");
  }
  if (input.folder === "permission_required") return result("folder_permission_required", false, false, false);
  const readable = input.folder === "verified_writable" || input.folder === "verified_read_only";
  if (input.lifecycle === "initial_enablement" && input.recovery_kit !== "ready") {
    return result("recovery_kit_required", readable, false, false);
  }
  if (input.browser_state === "key_vault_missing" || input.browser_state === "all_missing") {
    if (input.recovery_kit !== "ready") return result("recovery_kit_required", readable, false, true);
    return result("new_device_enrollment_required", readable, false, true);
  }
  if (input.browser_state === "catalog_missing" && input.key_vault_continuity !== "unambiguous") {
    return result("browser_state_recovery_required", readable, false, true);
  }
  if (input.folder === "verified_read_only") return result("verified_read_only", true, false, false);
  if (input.quota === "low") return result("low_quota_read_only", true, false, false);
  if (input.lifecycle === "existing_project" && input.browser_state !== "continuous") {
    return result("browser_state_recovery_required", true, false, false);
  }
  if (input.persistent_storage !== "granted" || input.quota === "unknown") {
    return result("ready_with_persistence_warning", true, true, false);
  }
  return result("fully_ready", true, true, false);
}

function parseRecoveryStateInput(input: Hc2RecoveryStateInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("HC-2 recovery state input must be a record.");
  }
  const keys = [
    "policy_version", "platform_supported", "folder", "recovery_kit", "browser_state",
    "key_vault_continuity", "persistent_storage", "quota", "opfs", "profile_state", "lifecycle"
  ];
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("HC-2 recovery state input must contain exactly the versioned fields.");
  }
  if (typeof input.platform_supported !== "boolean") throw new Error("Platform support must be boolean.");
  requireEnum(input.folder, ["verified_writable", "verified_read_only", "permission_required", "corrupt"], "folder state");
  requireEnum(input.recovery_kit, ["ready", "missing", "invalid"], "recovery kit state");
  requireEnum(input.browser_state, ["continuous", "catalog_missing", "key_vault_missing", "all_missing"], "browser state");
  requireEnum(input.key_vault_continuity, ["unambiguous", "ambiguous", "absent"], "key-vault continuity");
  requireEnum(input.persistent_storage, ["granted", "denied", "unknown"], "persistent storage");
  requireEnum(input.quota, ["sufficient", "low", "unknown"], "quota state");
  requireEnum(input.opfs, ["available", "missing", "unused"], "OPFS state");
  requireEnum(input.profile_state, ["single_writer", "conflicting_writer"], "profile state");
  requireEnum(input.lifecycle, ["initial_enablement", "existing_project", "recovery_ceremony_complete"], "recovery lifecycle");
}

function requireEnum(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`${label} has an unsupported value.`);
}

function result(
  readiness: Hc2RecoveryReadiness,
  mayRead: boolean,
  mayAuthor: boolean,
  newDevice: boolean
): Hc2RecoveryStateResult {
  return Object.freeze({
    policy_version: HC2_RECOVERY_POLICY_VERSION,
    readiness,
    may_read_verified_plaintext: mayRead,
    may_author: mayAuthor,
    must_create_new_device: newDevice,
    global_currency_claim: "not_permitted_offline"
  });
}

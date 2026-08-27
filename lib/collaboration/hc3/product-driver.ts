import {
  parseHc3ProductSnapshot,
  type Hc3ProductActionInput,
  type Hc3ProductQualificationDriver,
  type Hc3ProductSnapshot
} from "./product-contracts.ts";
import {
  createHc3ProductAuthorityDriver,
  readInjectedHc3ProductAuthorityRuntime
} from "./product-authority-driver.ts";

export const HC3_PRODUCT_QUALIFICATION_DRIVER_KEY = "__patchmarkHc3ProductQualificationDriver" as const;

export function readInjectedHc3ProductQualificationDriver(
  environment: unknown,
  projectId: string
): Hc3ProductQualificationDriver | null {
  if (!environment || typeof environment !== "object") return null;
  const authorityRuntime = readInjectedHc3ProductAuthorityRuntime(environment);
  if (authorityRuntime) {
    return createHc3ProductAuthorityDriver({ project_id: projectId, runtime: authorityRuntime });
  }
  const candidate = (environment as Record<string, unknown>)[HC3_PRODUCT_QUALIFICATION_DRIVER_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const driver = candidate as Partial<Hc3ProductQualificationDriver>;
  if (typeof driver.inspect !== "function" || typeof driver.invoke !== "function") return null;
  return Object.freeze({
    async inspect(input: Readonly<{ project_id: string }>) {
      if (input.project_id !== projectId) throw new Error("Qualification driver is bound to a different project.");
      return parseHc3ProductSnapshot(await driver.inspect?.(input));
    },
    async invoke(input: Hc3ProductActionInput) {
      if (input.project_id !== projectId) throw new Error("Qualification action is bound to a different project.");
      return parseHc3ProductSnapshot(await driver.invoke?.(input));
    },
    closeOperationalWork() {
      driver.closeOperationalWork?.();
    }
  });
}

export function unavailableHc3ProductSnapshot(input: Readonly<{
  project_id: string;
  project_title: string;
}>): Hc3ProductSnapshot {
  return parseHc3ProductSnapshot({
    schema_version: 1,
    record_kind: "hc3_product_qualification_snapshot",
    authority: "none",
    revision: BigInt(0),
    project_id: input.project_id,
    project_title: input.project_title,
    stage: "blocked",
    title: "Qualification support is not attached",
    explanation: "This development workspace needs an explicitly injected qualification driver before it can invoke collaboration authority.",
    recommended_action: null,
    available_actions: [],
    artifact: null,
    collaborators: [],
    conflicts: [],
    pending_invitation_count: 0,
    recovery_kit_verified: false,
    current_epoch_id: null,
    full_history_verified: null,
    source_project_immutable: true,
    direct_connection_state: "unavailable",
    encrypted_file_fallback_available: true,
    technical_diagnostic_code: "qualification_driver_unavailable"
  });
}

export const hc3WorkflowCommands = Object.freeze([
  "inspect_collaboration_readiness",
  "create_invitation_handoff",
  "copy_invitation",
  "present_invitation_as_qr",
  "share_invitation",
  "inspect_received_invitation",
  "begin_enrollment",
  "create_enrollment_response",
  "copy_enrollment_response",
  "share_enrollment_response",
  "inspect_received_enrollment_response",
  "authorize_admission",
  "export_admission_bundle",
  "select_admission_bundle",
  "preview_admission_import",
  "confirm_admission_import",
  "export_synchronization_bundle",
  "select_synchronization_bundle",
  "preview_synchronization_import",
  "confirm_synchronization_import",
  "inspect_convergence",
  "cancel_current_operational_step",
  "reconstruct_workflow_guidance_after_reopen"
] as const);

export type Hc3WorkflowCommand = (typeof hc3WorkflowCommands)[number];

export const hc3WorkflowStateKinds = Object.freeze([
  "not_ready",
  "ready",
  "preparing",
  "ready_to_share",
  "waiting_for_response",
  "received_unverified",
  "ready_for_confirmation",
  "processing",
  "completed",
  "cancelled",
  "unsupported",
  "blocked"
] as const);

export type Hc3WorkflowStateKind = (typeof hc3WorkflowStateKinds)[number];
export type Hc3WorkflowClassification = "normal" | "recoverable" | "blocking";

export type Hc3WorkflowStatus = Readonly<{
  authority: "none";
  state: Hc3WorkflowStateKind;
  title: string;
  explanation: string;
  available_actions: readonly Hc3WorkflowCommand[];
  artifact_available: boolean;
  confirmation_required: boolean;
  classification: Hc3WorkflowClassification;
  technical_diagnostic_code: string | null;
}>;

export const hc3WorkflowEvidencePhases = Object.freeze([
  "not_ready",
  "ready_to_invite",
  "invitation_created",
  "waiting_for_response",
  "response_received",
  "ready_to_authorize",
  "admission_ready",
  "admitted",
  "synchronization_required",
  "converged"
] as const);

export type Hc3WorkflowEvidencePhase = (typeof hc3WorkflowEvidencePhases)[number];

export type Hc3WorkflowEvidence = Readonly<{
  schema_version: 1;
  record_kind: "hc3_workflow_evidence";
  authority: "none";
  revision: bigint;
  source_project_immutable: boolean;
  phase: Hc3WorkflowEvidencePhase;
  portable_state: "absent" | "verified" | "corrupt" | "forked";
  custody_state: "absent" | "available" | "lost";
  invitation_state: "absent" | "active" | "consumed" | "cancelled" | "stale";
  membership_state: "not_enrolled" | "pending" | "active" | "revoked";
  epoch_state: "absent" | "current" | "stale" | "mismatched";
  continuity_state: "none" | "verified" | "gap" | "replay" | "fork";
  pending_journal_count: number;
  blockers: readonly string[];
}>;

export type Hc3SafePreview = Readonly<{
  authority: "none";
  purpose: "invitation" | "enrollment_response" | "admission" | "encrypted_update";
  structural_state: "valid" | "duplicate" | "stale" | "unsupported";
  intended_for_local_device: boolean | "unknown";
  role: "owner" | "editor" | "reviewer" | null;
  encrypted_byte_length: bigint | null;
  required_action: string;
  technical_details: Readonly<{
    artifact_kind: string;
    opaque_identifiers: readonly string[];
    diagnostic_code: string | null;
  }>;
}>;

export function parseHc3WorkflowEvidence(value: unknown): Hc3WorkflowEvidence {
  const record = exactRecord(value, "HC-3 workflow evidence", [
    "schema_version", "record_kind", "authority", "revision", "source_project_immutable", "phase", "portable_state",
    "custody_state", "invitation_state", "membership_state", "epoch_state",
    "continuity_state", "pending_journal_count", "blockers"
  ]);
  if (record.schema_version !== 1 || record.record_kind !== "hc3_workflow_evidence" || record.authority !== "none") {
    throw new Error("HC-3 workflow evidence version, kind, or authority is invalid.");
  }
  if (typeof record.revision !== "bigint" || record.revision < BigInt(0)) throw new Error("HC-3 workflow evidence revision is invalid.");
  if (typeof record.source_project_immutable !== "boolean") throw new Error("HC-3 source-project immutability evidence is invalid.");
  if (!Number.isSafeInteger(record.pending_journal_count) || Number(record.pending_journal_count) < 0) {
    throw new Error("HC-3 pending-journal count is invalid.");
  }
  if (!Array.isArray(record.blockers) || record.blockers.some((item) => typeof item !== "string" || !item || containsSecretLabel(item))) {
    throw new Error("HC-3 workflow blockers must be secret-free non-empty strings.");
  }
  if (new Set(record.blockers).size !== record.blockers.length) throw new Error("HC-3 workflow blockers must be unique.");
  return freeze({
    schema_version: 1,
    record_kind: "hc3_workflow_evidence",
    authority: "none",
    revision: record.revision,
    source_project_immutable: record.source_project_immutable,
    phase: enumeration(record.phase, hc3WorkflowEvidencePhases, "HC-3 workflow phase"),
    portable_state: enumeration(record.portable_state, ["absent", "verified", "corrupt", "forked"] as const, "portable state"),
    custody_state: enumeration(record.custody_state, ["absent", "available", "lost"] as const, "custody state"),
    invitation_state: enumeration(record.invitation_state, ["absent", "active", "consumed", "cancelled", "stale"] as const, "invitation state"),
    membership_state: enumeration(record.membership_state, ["not_enrolled", "pending", "active", "revoked"] as const, "membership state"),
    epoch_state: enumeration(record.epoch_state, ["absent", "current", "stale", "mismatched"] as const, "epoch state"),
    continuity_state: enumeration(record.continuity_state, ["none", "verified", "gap", "replay", "fork"] as const, "continuity state"),
    pending_journal_count: Number(record.pending_journal_count),
    blockers: freeze([...record.blockers].sort())
  });
}

export function parseHc3SafePreview(value: unknown): Hc3SafePreview {
  const record = exactRecord(value, "HC-3 safe preview", [
    "authority", "purpose", "structural_state", "intended_for_local_device", "role",
    "encrypted_byte_length", "required_action", "technical_details"
  ]);
  const details = exactRecord(record.technical_details, "HC-3 technical details", [
    "artifact_kind", "opaque_identifiers", "diagnostic_code"
  ]);
  if (record.authority !== "none") throw new Error("HC-3 previews cannot carry authority.");
  if (record.intended_for_local_device !== "unknown" && typeof record.intended_for_local_device !== "boolean") {
    throw new Error("HC-3 preview device intent is invalid.");
  }
  if (record.encrypted_byte_length !== null && (typeof record.encrypted_byte_length !== "bigint" || record.encrypted_byte_length < BigInt(0))) {
    throw new Error("HC-3 preview byte length is invalid.");
  }
  if (typeof record.required_action !== "string" || !record.required_action || containsSecretLabel(record.required_action)) {
    throw new Error("HC-3 preview guidance is invalid.");
  }
  if (typeof details.artifact_kind !== "string" || !details.artifact_kind || containsSecretLabel(details.artifact_kind)) {
    throw new Error("HC-3 preview artifact kind is invalid.");
  }
  if (!Array.isArray(details.opaque_identifiers) || details.opaque_identifiers.some((item) => typeof item !== "string" || !isOpaqueIdentifier(item))) {
    throw new Error("HC-3 technical details contain a non-opaque identifier.");
  }
  if (details.diagnostic_code !== null && (typeof details.diagnostic_code !== "string" || !/^[a-z0-9_]{1,64}$/.test(details.diagnostic_code))) {
    throw new Error("HC-3 technical diagnostic code is invalid.");
  }
  return freeze({
    authority: "none",
    purpose: enumeration(record.purpose, ["invitation", "enrollment_response", "admission", "encrypted_update"] as const, "preview purpose"),
    structural_state: enumeration(record.structural_state, ["valid", "duplicate", "stale", "unsupported"] as const, "preview state"),
    intended_for_local_device: record.intended_for_local_device,
    role: record.role === null ? null : enumeration(record.role, ["owner", "editor", "reviewer"] as const, "preview role"),
    encrypted_byte_length: record.encrypted_byte_length,
    required_action: record.required_action,
    technical_details: freeze({
      artifact_kind: details.artifact_kind,
      opaque_identifiers: freeze([...details.opaque_identifiers]),
      diagnostic_code: details.diagnostic_code
    })
  });
}

export function deriveHc3WorkflowStatus(evidenceValue: Hc3WorkflowEvidence): Hc3WorkflowStatus {
  const evidence = parseHc3WorkflowEvidence(evidenceValue);
  if (!evidence.source_project_immutable || evidence.blockers.length || evidence.portable_state === "corrupt" || evidence.portable_state === "forked" ||
      evidence.continuity_state === "fork" || evidence.epoch_state === "mismatched" || evidence.membership_state === "revoked") {
    return createHc3WorkflowStatus("blocked", {
      explanation: "Collaboration evidence is inconsistent or no longer authorized. Resolve the local project state before continuing.",
      actions: ["inspect_collaboration_readiness", "reconstruct_workflow_guidance_after_reopen"],
      diagnostic_code: evidence.source_project_immutable ? (evidence.blockers[0] ?? blockedCode(evidence)) : "source_project_changed"
    });
  }
  if (evidence.portable_state === "absent" || evidence.custody_state === "absent" || evidence.custody_state === "lost" || evidence.phase === "not_ready") {
    return createHc3WorkflowStatus("not_ready", {
      explanation: "This local project is not ready for a manual collaboration handoff.",
      actions: ["inspect_collaboration_readiness", "reconstruct_workflow_guidance_after_reopen"]
    });
  }
  switch (evidence.phase) {
    case "ready_to_invite":
      return createHc3WorkflowStatus("ready", { explanation: "This project can create a new Invitation.", actions: ["create_invitation_handoff", "inspect_collaboration_readiness"] });
    case "invitation_created":
      return createHc3WorkflowStatus("ready_to_share", { explanation: "The Invitation is ready to copy, show as QR, or share.", actions: ["copy_invitation", "present_invitation_as_qr", "share_invitation"], artifact_available: true });
    case "waiting_for_response":
      return createHc3WorkflowStatus("waiting_for_response", { explanation: "Share the Invitation, then inspect the returned Response.", actions: ["copy_invitation", "share_invitation", "inspect_received_enrollment_response"], artifact_available: true });
    case "response_received":
    case "ready_to_authorize":
      return createHc3WorkflowStatus("ready_for_confirmation", { explanation: "The Response was previewed. Revalidate it before explicitly authorizing admission.", actions: ["authorize_admission", "cancel_current_operational_step"], confirmation_required: true });
    case "admission_ready":
      return createHc3WorkflowStatus("ready_to_share", { explanation: "The encrypted admission file is ready to save and transfer.", actions: ["export_admission_bundle"], artifact_available: true });
    case "admitted":
    case "synchronization_required":
      return createHc3WorkflowStatus("ready", { explanation: "Create an Encrypted update and exchange files until verification reports Sync complete.", actions: ["export_synchronization_bundle", "select_synchronization_bundle", "inspect_convergence"] });
    case "converged":
      return createHc3WorkflowStatus("completed", { explanation: "Sync complete. Both replicas have verified the same authoritative and projected state.", actions: ["inspect_convergence", "export_synchronization_bundle"] });
  }
}

export function createHc3WorkflowStatus(state: Hc3WorkflowStateKind, input: Readonly<{
  explanation?: string;
  actions?: readonly Hc3WorkflowCommand[];
  artifact_available?: boolean;
  confirmation_required?: boolean;
  classification?: Hc3WorkflowClassification;
  diagnostic_code?: string | null;
}> = {}): Hc3WorkflowStatus {
  const defaults = stateDefaults(state);
  const actions = input.actions ?? defaults.actions;
  for (const action of actions) enumeration(action, hc3WorkflowCommands, "HC-3 workflow action");
  const code = input.diagnostic_code ?? null;
  if (code !== null && !/^[a-z0-9_]{1,64}$/.test(code)) throw new Error("HC-3 technical diagnostic code is invalid.");
  return freeze({
    authority: "none",
    state,
    title: defaults.title,
    explanation: input.explanation ?? defaults.explanation,
    available_actions: freeze([...actions]),
    artifact_available: input.artifact_available ?? false,
    confirmation_required: input.confirmation_required ?? false,
    classification: input.classification ?? defaults.classification,
    technical_diagnostic_code: code
  });
}

function stateDefaults(state: Hc3WorkflowStateKind): Readonly<{
  title: string;
  explanation: string;
  actions: readonly Hc3WorkflowCommand[];
  classification: Hc3WorkflowClassification;
}> {
  const values: Record<Hc3WorkflowStateKind, { title: string; explanation: string; actions: readonly Hc3WorkflowCommand[]; classification: Hc3WorkflowClassification }> = {
    not_ready: { title: "Collaboration not ready", explanation: "Finish local project and key setup before continuing.", actions: ["inspect_collaboration_readiness"], classification: "blocking" },
    ready: { title: "Ready", explanation: "Choose an explicit next action.", actions: [], classification: "normal" },
    preparing: { title: "Preparing", explanation: "Patchmark is preparing the requested artifact.", actions: ["cancel_current_operational_step"], classification: "normal" },
    ready_to_share: { title: "Ready to share", explanation: "The artifact is available for an explicit handoff.", actions: [], classification: "normal" },
    waiting_for_response: { title: "Waiting for Response", explanation: "No background activity is running. Continue when the other person returns an artifact.", actions: [], classification: "normal" },
    received_unverified: { title: "Received, not verified", explanation: "The artifact is only structurally inspected and has not changed project authority.", actions: [], classification: "recoverable" },
    ready_for_confirmation: { title: "Ready for confirmation", explanation: "Review the preview, then explicitly confirm the authoritative operation.", actions: ["cancel_current_operational_step"], classification: "normal" },
    processing: { title: "Verifying", explanation: "Patchmark is invoking the existing authoritative operation once.", actions: [], classification: "normal" },
    completed: { title: "Sync complete", explanation: "The explicit operation completed and durable evidence was reopened.", actions: [], classification: "normal" },
    cancelled: { title: "Cancelled", explanation: "Nothing was changed. You can retry the explicit step.", actions: ["inspect_collaboration_readiness"], classification: "recoverable" },
    unsupported: { title: "Not supported here", explanation: "Use the available copy or save-file fallback.", actions: [], classification: "recoverable" },
    blocked: { title: "Cannot continue safely", explanation: "Validation failed closed. Review the technical diagnostic or choose a different artifact.", actions: ["cancel_current_operational_step"], classification: "blocking" }
  };
  return values[state];
}

function blockedCode(evidence: Hc3WorkflowEvidence): string {
  if (evidence.portable_state === "corrupt") return "portable_corrupt";
  if (evidence.portable_state === "forked" || evidence.continuity_state === "fork") return "replica_fork";
  if (evidence.epoch_state === "mismatched") return "epoch_mismatch";
  if (evidence.membership_state === "revoked") return "device_revoked";
  return "evidence_blocked";
}

function containsSecretLabel(value: string): boolean {
  return /private[_ -]?key|epoch[_ -]?plaintext|recovery[_ -]?(?:material|secret|bytes)|password/i.test(value);
}

function isOpaqueIdentifier(value: string): boolean {
  return /^pm:[a-z0-9-]+:v[123]:[a-z2-7]{26,52}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an exact record.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unexpected fields.`);
  }
  return record;
}

function enumeration<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is unsupported.`);
  return value as T[number];
}

function freeze<T>(value: T): Readonly<T> { return Object.freeze(value); }

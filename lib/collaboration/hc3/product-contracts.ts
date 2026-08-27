export const hc3ProductActions = Object.freeze([
  "create_collaboration_copy",
  "verify_recovery_kit",
  "create_invitation",
  "cancel_invitation",
  "preview_received_artifact",
  "continue_invitation",
  "create_response",
  "authorize_admission",
  "save_encrypted_file",
  "select_encrypted_file",
  "preview_encrypted_file",
  "import_encrypted_file",
  "create_direct_offer",
  "open_direct_offer",
  "create_direct_answer",
  "open_direct_answer",
  "sync_directly",
  "use_encrypted_file",
  "change_role",
  "revoke_device",
  "revoke_membership",
  "resolve_conflict",
  "reopen_and_verify"
] as const);

export type Hc3ProductAction = (typeof hc3ProductActions)[number];

export const hc3ProductStages = Object.freeze([
  "setup_required",
  "recovery_required",
  "ready_to_invite",
  "waiting_for_response",
  "complete_invitation",
  "admission_ready",
  "admission_required",
  "synchronization_required",
  "conflict_required",
  "revocation_required",
  "converged",
  "blocked"
] as const);

export type Hc3ProductStage = (typeof hc3ProductStages)[number];
export type Hc3ProductRole = "owner" | "editor" | "reviewer";

export type Hc3ProductArtifact = Readonly<{
  authority: "none";
  kind: "invitation" | "response" | "direct_offer" | "direct_answer" | "encrypted_file" | "receipt";
  text: string | null;
  filename: string | null;
  exact_bytes: Uint8Array | null;
  eligible_for_qr: boolean;
}>;

export type Hc3ProductCollaborator = Readonly<{
  person_id: string;
  display_name: string;
  role: Hc3ProductRole;
  membership_state: "active" | "pending" | "revoked";
  devices: readonly Readonly<{
    device_id: string;
    display_name: string;
    state: "active" | "revoked";
    current: boolean;
  }>[];
}>;

export type Hc3ProductConflict = Readonly<{
  conflict_id: string;
  subject: string;
  contenders: readonly Readonly<{ contender_id: string; summary: string }>[];
  can_resolve: boolean;
}>;

export type Hc3ProductSnapshot = Readonly<{
  schema_version: 1;
  record_kind: "hc3_product_qualification_snapshot";
  authority: "none";
  revision: bigint;
  project_id: string;
  project_title: string;
  stage: Hc3ProductStage;
  title: string;
  explanation: string;
  recommended_action: Hc3ProductAction | null;
  available_actions: readonly Hc3ProductAction[];
  artifact: Hc3ProductArtifact | null;
  collaborators: readonly Hc3ProductCollaborator[];
  conflicts: readonly Hc3ProductConflict[];
  pending_invitation_count: number;
  recovery_kit_verified: boolean;
  current_epoch_id: string | null;
  full_history_verified: boolean | null;
  source_project_immutable: boolean;
  direct_connection_state: "idle" | "waiting" | "connected" | "interrupted" | "unavailable";
  encrypted_file_fallback_available: boolean;
  technical_diagnostic_code: string | null;
}>;

export type Hc3ProductActionInput = Readonly<{
  action: Hc3ProductAction;
  expected_revision: bigint;
  project_id: string;
  role?: Hc3ProductRole;
  artifact_text?: string;
  selected_id?: string;
  contender_ids?: readonly string[];
}>;

export interface Hc3ProductQualificationDriver {
  inspect(input: Readonly<{ project_id: string }>): Promise<unknown>;
  invoke(input: Hc3ProductActionInput): Promise<unknown>;
  closeOperationalWork?(): void;
}

export function parseHc3ProductSnapshot(value: unknown): Hc3ProductSnapshot {
  const record = exact(value, "product qualification snapshot", [
    "schema_version", "record_kind", "authority", "revision", "project_id",
    "project_title", "stage", "title", "explanation", "recommended_action",
    "available_actions", "artifact", "collaborators", "conflicts",
    "pending_invitation_count", "recovery_kit_verified", "current_epoch_id",
    "full_history_verified", "source_project_immutable", "direct_connection_state",
    "encrypted_file_fallback_available", "technical_diagnostic_code"
  ]);
  if (record.schema_version !== 1 || record.record_kind !== "hc3_product_qualification_snapshot" || record.authority !== "none") {
    throw new Error("Product qualification snapshot version, kind, or authority is invalid.");
  }
  if (typeof record.revision !== "bigint" || record.revision < BigInt(0)) throw new Error("Product qualification revision is invalid.");
  const projectId = safeText(record.project_id, "project identity", 256);
  const actions = uniqueArray(record.available_actions, "available actions").map(action);
  const recommended = record.recommended_action === null ? null : action(record.recommended_action);
  if (recommended !== null && !actions.includes(recommended)) throw new Error("Recommended action must be currently available.");
  const pending = nonnegative(record.pending_invitation_count, "pending invitation count");
  const diagnostic = record.technical_diagnostic_code === null
    ? null
    : diagnosticCode(record.technical_diagnostic_code);
  return freeze({
    schema_version: 1,
    record_kind: "hc3_product_qualification_snapshot",
    authority: "none",
    revision: record.revision,
    project_id: projectId,
    project_title: safeText(record.project_title, "project title", 512),
    stage: enumeration(record.stage, hc3ProductStages, "product stage"),
    title: safeGuidance(record.title, "status title", 256),
    explanation: safeGuidance(record.explanation, "status explanation", 2_048),
    recommended_action: recommended,
    available_actions: freeze(actions),
    artifact: record.artifact === null ? null : parseArtifact(record.artifact),
    collaborators: freeze(uniqueArray(record.collaborators, "collaborators").map(parseCollaborator)),
    conflicts: freeze(uniqueArray(record.conflicts, "conflicts").map(parseConflict)),
    pending_invitation_count: pending,
    recovery_kit_verified: boolean(record.recovery_kit_verified, "recovery-kit state"),
    current_epoch_id: record.current_epoch_id === null ? null : opaque(record.current_epoch_id, "epoch identity"),
    full_history_verified: record.full_history_verified === null ? null : boolean(record.full_history_verified, "history boundary"),
    source_project_immutable: boolean(record.source_project_immutable, "source immutability"),
    direct_connection_state: enumeration(record.direct_connection_state, ["idle", "waiting", "connected", "interrupted", "unavailable"] as const, "direct state"),
    encrypted_file_fallback_available: boolean(record.encrypted_file_fallback_available, "encrypted-file fallback"),
    technical_diagnostic_code: diagnostic
  });
}

export function validateHc3ProductActionInput(value: Hc3ProductActionInput): Hc3ProductActionInput {
  const expected = typeof value.expected_revision === "bigint" && value.expected_revision >= BigInt(0)
    ? value.expected_revision
    : fail("Product action revision is invalid.");
  const contenderIds = value.contender_ids?.map((entry) => opaque(entry, "contender identity"));
  return freeze({
    action: action(value.action),
    expected_revision: expected,
    project_id: safeText(value.project_id, "project identity", 256),
    ...(value.role ? { role: enumeration(value.role, ["owner", "editor", "reviewer"] as const, "role") } : {}),
    ...(value.artifact_text !== undefined ? { artifact_text: safeArtifactText(value.artifact_text) } : {}),
    ...(value.selected_id !== undefined ? { selected_id: opaque(value.selected_id, "selected identity") } : {}),
    ...(contenderIds ? { contender_ids: freeze([...new Set(contenderIds)].sort()) } : {})
  });
}

function parseArtifact(value: unknown): Hc3ProductArtifact {
  const record = exact(value, "prepared artifact", ["authority", "kind", "text", "filename", "exact_bytes", "eligible_for_qr"]);
  if (record.authority !== "none") throw new Error("Prepared product artifacts carry no authority.");
  const exactBytes = record.exact_bytes === null
    ? null
    : record.exact_bytes instanceof Uint8Array
      ? Uint8Array.from(record.exact_bytes)
      : fail<Uint8Array>("Prepared artifact bytes are invalid.");
  if ((record.text === null) === (exactBytes === null)) throw new Error("Prepared artifacts contain exactly one text or byte representation.");
  const filename = record.filename === null ? null : safeFilename(record.filename);
  return freeze({
    authority: "none",
    kind: enumeration(record.kind, ["invitation", "response", "direct_offer", "direct_answer", "encrypted_file", "receipt"] as const, "artifact kind"),
    text: record.text === null ? null : safeArtifactText(record.text),
    filename,
    exact_bytes: exactBytes,
    eligible_for_qr: boolean(record.eligible_for_qr, "QR eligibility")
  });
}

function parseCollaborator(value: unknown): Hc3ProductCollaborator {
  const record = exact(value, "collaborator", ["person_id", "display_name", "role", "membership_state", "devices"]);
  const devices = uniqueArray(record.devices, "devices").map((item) => {
    const device = exact(item, "device", ["device_id", "display_name", "state", "current"]);
    return freeze({
      device_id: opaque(device.device_id, "device identity"),
      display_name: safeText(device.display_name, "device name", 256),
      state: enumeration(device.state, ["active", "revoked"] as const, "device state"),
      current: boolean(device.current, "current-device marker")
    });
  });
  if (devices.filter((device) => device.current).length > 1) throw new Error("Only one displayed device may be current.");
  return freeze({
    person_id: opaque(record.person_id, "person identity"),
    display_name: safeText(record.display_name, "collaborator name", 256),
    role: enumeration(record.role, ["owner", "editor", "reviewer"] as const, "role"),
    membership_state: enumeration(record.membership_state, ["active", "pending", "revoked"] as const, "membership state"),
    devices: freeze(devices)
  });
}

function parseConflict(value: unknown): Hc3ProductConflict {
  const record = exact(value, "conflict", ["conflict_id", "subject", "contenders", "can_resolve"]);
  const contenders = uniqueArray(record.contenders, "conflict contenders").map((item) => {
    const contender = exact(item, "conflict contender", ["contender_id", "summary"]);
    return freeze({ contender_id: opaque(contender.contender_id, "contender identity"), summary: safeGuidance(contender.summary, "contender summary", 512) });
  });
  if (contenders.length < 2) throw new Error("A displayed conflict requires every observed contender.");
  return freeze({
    conflict_id: opaque(record.conflict_id, "conflict identity"),
    subject: safeGuidance(record.subject, "conflict subject", 512),
    contenders: freeze(contenders),
    can_resolve: boolean(record.can_resolve, "conflict resolution eligibility")
  });
}

function action(value: unknown): Hc3ProductAction { return enumeration(value, hc3ProductActions, "product action"); }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} is invalid.`); return value; }
function diagnosticCode(value: unknown): string { if (typeof value !== "string" || !/^[a-z0-9_]{1,64}$/.test(value)) throw new Error("Technical diagnostic code is invalid."); return value; }
function enumeration<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] { if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is unsupported.`); return value as T[number]; }
function exact(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an exact record.`); const record = value as Record<string, unknown>; const actual = Object.keys(record).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unexpected or missing fields.`); return record; }
function freeze<T>(value: T): Readonly<T> { return Object.freeze(value); }
function nonnegative(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid.`); return Number(value); }
function opaque(value: unknown, label: string): string { const result = safeText(value, label, 512); if (!/^(?:pm:[a-z0-9-]+:v[123]:[a-z2-7]{12,64}|[0-9a-f]{32,128})$/.test(result)) throw new Error(`${label} is not opaque.`); return result; }
function safeArtifactText(value: unknown): string { if (typeof value !== "string" || value.length < 1 || value.length > 93_000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Artifact text is invalid."); return value; }
function safeFilename(value: unknown): string { const result = safeText(value, "artifact filename", 255); if (result.includes("/") || result.includes("\\") || result === "." || result === "..") throw new Error("Artifact filename is unsafe."); return result; }
function safeGuidance(value: unknown, label: string, maximum: number): string { const result = safeText(value, label, maximum); if (/private[_ -]?key|recovery[_ -]?(?:secret|bytes)|epoch[_ -]?plaintext/i.test(result)) throw new Error(`${label} contains secret-bearing terminology.`); return result; }
function safeText(value: unknown, label: string, maximum: number): string { if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid.`); return value; }
function uniqueArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array.`); return [...value]; }
function fail<T = never>(message: string): T { throw new Error(message); }

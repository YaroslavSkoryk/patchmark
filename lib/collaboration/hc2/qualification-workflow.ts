/**
 * HC-2 Slice 8 disabled qualification facade.
 *
 * This module owns no storage, cryptography, transport, projector, or authority.
 * Every capability is injected and every operation is one explicit caller action.
 */

export const hc2QualificationActions = Object.freeze([
  "inspect_readiness",
  "plan_foundation",
  "execute_foundation",
  "verify_recovery_kit",
  "create_invitation",
  "cancel_invitation",
  "prepare_enrollment_request",
  "complete_possession_challenge",
  "approve_enrollment",
  "export_admission_bundle",
  "import_admission_bundle",
  "inspect_status",
  "plan_synchronization",
  "export_sync_artifact",
  "import_sync_artifact",
  "confirm_convergence",
  "create_semantic_operation",
  "resolve_conflict",
  "revoke_device",
  "recover_profile",
  "reopen_and_verify"
] as const);

export type Hc2QualificationAction = (typeof hc2QualificationActions)[number];

export const hc2QualificationGuidance = Object.freeze([
  "foundation_plan_required",
  "recovery_kit_required",
  "invitation_handoff_required",
  "enrollment_response_required",
  "admission_bundle_ready",
  "import_required",
  "sync_artifact_ready",
  "more_sync_required",
  "conflict_resolution_required",
  "revocation_required",
  "recovery_required",
  "converged",
  "blocked"
] as const);

export type Hc2QualificationGuidance = (typeof hc2QualificationGuidance)[number];

export type Hc2QualificationDurableEvidence = Readonly<{
  schema_version: 1;
  record_kind: "hc2_disabled_qualification_evidence";
  revision: bigint;
  source_snapshot_sha256: string;
  source_immutable: boolean;
  portable_state: "absent" | "verified" | "forked" | "corrupt";
  custody_state: "absent" | "planned" | "installed" | "lost";
  recovery_kit_state: "absent" | "written" | "verified";
  invitation_state: "absent" | "created" | "cancelled" | "consumed";
  enrollment_state: "absent" | "requested" | "challenged" | "approved";
  admission_state: "absent" | "ready" | "exported" | "imported";
  synchronization_state: "idle" | "artifact_ready" | "more_required" | "converged";
  conflict_state: "none" | "unresolved" | "resolved";
  revocation_state: "not_required" | "required" | "complete";
  profile_state: "available" | "lost" | "recovered";
  recovery_state: "not_required" | "required" | "complete";
  final_verification: "pending" | "verified";
  pending_journal_count: number;
  transport_continuity: "none" | "verified" | "gap" | "fork";
  quarantine_state: "none" | "retryable" | "permanent";
  blockers: readonly string[];
}>;

export type Hc2QualificationStatus = Readonly<{
  authority: "none";
  revision: bigint;
  guidance: Hc2QualificationGuidance;
  evidence: Hc2QualificationDurableEvidence;
}>;

export type Hc2QualificationOperationResult = Readonly<{
  status: "completed" | "more_required" | "blocked";
  evidence: Readonly<Record<string, QualificationDiagnosticValue>>;
}>;

export type QualificationDiagnosticValue = string | number | boolean | null | readonly QualificationDiagnosticValue[] | Readonly<{ [key: string]: QualificationDiagnosticValue }>;

export interface Hc2QualificationEvidenceReader {
  readDurableEvidence(): Promise<unknown>;
  readSourceSnapshotSha256(): Promise<string>;
}

export interface Hc2QualificationOperationPort {
  invoke(input: Readonly<{
    action: Hc2QualificationAction;
    expected_revision: bigint;
    source_snapshot_sha256: string;
    input: Readonly<Record<string, QualificationDiagnosticValue>>;
  }>): Promise<unknown>;
}

export type Hc2QualificationActionOutcome = Readonly<{
  authority: "none";
  action: Hc2QualificationAction;
  operation: Hc2QualificationOperationResult;
  status: Hc2QualificationStatus;
  source_immutable: true;
}>;

export class Hc2DisabledQualificationController {
  readonly #evidence: Hc2QualificationEvidenceReader;
  readonly #operations: Hc2QualificationOperationPort;

  constructor(input: Readonly<{ evidence: Hc2QualificationEvidenceReader; operations: Hc2QualificationOperationPort }>) {
    if (!input?.evidence || !input.operations) throw new Error("Qualification workflow requires injected evidence and operation ports.");
    this.#evidence = input.evidence;
    this.#operations = input.operations;
  }

  async inspectStatus(): Promise<Hc2QualificationStatus> {
    const evidence = parseHc2QualificationDurableEvidence(await this.#evidence.readDurableEvidence());
    const currentSource = parseSha256(await this.#evidence.readSourceSnapshotSha256(), "current source snapshot");
    if (currentSource !== evidence.source_snapshot_sha256 || !evidence.source_immutable) {
      return freeze({ authority: "none", revision: evidence.revision, guidance: "blocked", evidence: freeze({ ...evidence, source_immutable: false, blockers: freeze([...evidence.blockers, "source_project_changed"].sort()) }) });
    }
    return freeze({ authority: "none", revision: evidence.revision, guidance: deriveQualificationGuidance(evidence), evidence });
  }

  async perform(action: Hc2QualificationAction, input: Readonly<Record<string, QualificationDiagnosticValue>> = freeze({})): Promise<Hc2QualificationActionOutcome> {
    const parsedAction = parseAction(action);
    const safeInput = parseDiagnostics(input, "qualification action input");
    const before = await this.inspectStatus();
    if (before.guidance === "blocked" && parsedAction !== "inspect_status" && parsedAction !== "inspect_readiness") throw new Error("Blocked qualification evidence cannot authorize another operation.");
    let raw: unknown;
    try {
      raw = await this.#operations.invoke({ action: parsedAction, expected_revision: before.revision, source_snapshot_sha256: before.evidence.source_snapshot_sha256, input: safeInput });
    } catch (error) {
      await this.#assertSourceUnchanged(before.evidence.source_snapshot_sha256);
      throw error;
    }
    await this.#assertSourceUnchanged(before.evidence.source_snapshot_sha256);
    const operation = parseOperationResult(raw);
    const after = await this.inspectStatus();
    if (after.evidence.source_snapshot_sha256 !== before.evidence.source_snapshot_sha256) throw new Error("Qualification operation changed the immutable source-project boundary.");
    return freeze({ authority: "none", action: parsedAction, operation, status: after, source_immutable: true });
  }

  inspectReadiness(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("inspect_readiness", input); }
  planFoundation(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("plan_foundation", input); }
  executeFoundation(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("execute_foundation", input); }
  verifyRecoveryKit(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("verify_recovery_kit", input); }
  createInvitation(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("create_invitation", input); }
  cancelInvitation(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("cancel_invitation", input); }
  prepareEnrollmentRequest(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("prepare_enrollment_request", input); }
  completePossessionChallenge(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("complete_possession_challenge", input); }
  approveEnrollment(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("approve_enrollment", input); }
  exportAdmissionBundle(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("export_admission_bundle", input); }
  importAdmissionBundle(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("import_admission_bundle", input); }
  planSynchronization(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("plan_synchronization", input); }
  exportSyncArtifact(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("export_sync_artifact", input); }
  importSyncArtifact(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("import_sync_artifact", input); }
  confirmConvergence(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("confirm_convergence", input); }
  createSemanticOperation(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("create_semantic_operation", input); }
  resolveConflict(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("resolve_conflict", input); }
  revokeDevice(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("revoke_device", input); }
  recoverProfile(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("recover_profile", input); }
  reopenAndVerify(input?: Readonly<Record<string, QualificationDiagnosticValue>>) { return this.perform("reopen_and_verify", input); }

  async #assertSourceUnchanged(expected: string): Promise<void> {
    if (parseSha256(await this.#evidence.readSourceSnapshotSha256(), "current source snapshot") !== expected) throw new Error("Qualification operation modified the immutable source project.");
  }
}

export function deriveQualificationGuidance(value: Hc2QualificationDurableEvidence): Hc2QualificationGuidance {
  const evidence = parseHc2QualificationDurableEvidence(value);
  if (!evidence.source_immutable || evidence.blockers.length > 0 || evidence.portable_state === "forked" || evidence.portable_state === "corrupt" || evidence.transport_continuity === "fork" || evidence.quarantine_state === "permanent") return "blocked";
  if (evidence.profile_state === "lost" || evidence.recovery_state === "required" || evidence.custody_state === "lost") return "recovery_required";
  if (evidence.portable_state === "absent" || evidence.custody_state === "absent" || evidence.custody_state === "planned") return "foundation_plan_required";
  if (evidence.recovery_kit_state !== "verified") return "recovery_kit_required";
  if (evidence.invitation_state === "absent" || evidence.invitation_state === "created") return "invitation_handoff_required";
  if (evidence.enrollment_state !== "approved") return "enrollment_response_required";
  if (evidence.admission_state === "ready") return "admission_bundle_ready";
  if (evidence.admission_state === "exported") return "import_required";
  if (evidence.admission_state !== "imported") return "enrollment_response_required";
  if (evidence.conflict_state === "unresolved") return "conflict_resolution_required";
  if (evidence.revocation_state === "required") return "revocation_required";
  if (evidence.synchronization_state === "artifact_ready") return "sync_artifact_ready";
  if (evidence.synchronization_state === "more_required" || evidence.transport_continuity === "gap" || evidence.quarantine_state === "retryable") return "more_sync_required";
  if (evidence.synchronization_state === "converged" && evidence.final_verification === "verified" && evidence.pending_journal_count === 0) return "converged";
  return "more_sync_required";
}

export function parseHc2QualificationDurableEvidence(value: unknown): Hc2QualificationDurableEvidence {
  const record = exactRecord(value, "qualification evidence", ["schema_version", "record_kind", "revision", "source_snapshot_sha256", "source_immutable", "portable_state", "custody_state", "recovery_kit_state", "invitation_state", "enrollment_state", "admission_state", "synchronization_state", "conflict_state", "revocation_state", "profile_state", "recovery_state", "final_verification", "pending_journal_count", "transport_continuity", "quarantine_state", "blockers"]);
  if (record.schema_version !== 1 || record.record_kind !== "hc2_disabled_qualification_evidence") throw new Error("Qualification evidence version or kind is unsupported.");
  if (typeof record.revision !== "bigint" || record.revision < BigInt(0)) throw new Error("Qualification revision must be an unsigned integer.");
  if (typeof record.source_immutable !== "boolean") throw new Error("Qualification source immutability flag is malformed.");
  if (!Number.isSafeInteger(record.pending_journal_count) || Number(record.pending_journal_count) < 0) throw new Error("Qualification pending-journal count is malformed.");
  if (!Array.isArray(record.blockers) || record.blockers.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(record.blockers).size !== record.blockers.length) throw new Error("Qualification blockers must be unique non-empty strings.");
  return freeze({
    schema_version: 1,
    record_kind: "hc2_disabled_qualification_evidence",
    revision: record.revision,
    source_snapshot_sha256: parseSha256(record.source_snapshot_sha256, "qualification source snapshot"),
    source_immutable: record.source_immutable,
    portable_state: enumeration(record.portable_state, ["absent", "verified", "forked", "corrupt"] as const, "portable state"),
    custody_state: enumeration(record.custody_state, ["absent", "planned", "installed", "lost"] as const, "custody state"),
    recovery_kit_state: enumeration(record.recovery_kit_state, ["absent", "written", "verified"] as const, "recovery-kit state"),
    invitation_state: enumeration(record.invitation_state, ["absent", "created", "cancelled", "consumed"] as const, "invitation state"),
    enrollment_state: enumeration(record.enrollment_state, ["absent", "requested", "challenged", "approved"] as const, "enrollment state"),
    admission_state: enumeration(record.admission_state, ["absent", "ready", "exported", "imported"] as const, "admission state"),
    synchronization_state: enumeration(record.synchronization_state, ["idle", "artifact_ready", "more_required", "converged"] as const, "synchronization state"),
    conflict_state: enumeration(record.conflict_state, ["none", "unresolved", "resolved"] as const, "conflict state"),
    revocation_state: enumeration(record.revocation_state, ["not_required", "required", "complete"] as const, "revocation state"),
    profile_state: enumeration(record.profile_state, ["available", "lost", "recovered"] as const, "profile state"),
    recovery_state: enumeration(record.recovery_state, ["not_required", "required", "complete"] as const, "recovery state"),
    final_verification: enumeration(record.final_verification, ["pending", "verified"] as const, "final verification"),
    pending_journal_count: Number(record.pending_journal_count),
    transport_continuity: enumeration(record.transport_continuity, ["none", "verified", "gap", "fork"] as const, "transport continuity"),
    quarantine_state: enumeration(record.quarantine_state, ["none", "retryable", "permanent"] as const, "quarantine state"),
    blockers: freeze([...record.blockers].sort())
  });
}

function parseOperationResult(value: unknown): Hc2QualificationOperationResult {
  const record = exactRecord(value, "qualification operation result", ["status", "evidence"]);
  return freeze({ status: enumeration(record.status, ["completed", "more_required", "blocked"] as const, "qualification operation status"), evidence: parseDiagnostics(record.evidence, "qualification operation evidence") });
}

function parseDiagnostics(value: unknown, label: string): Readonly<Record<string, QualificationDiagnosticValue>> {
  const record = exactRecord(value, label, Object.keys(value as object));
  return freeze(Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if (/password|secret|private|plaintext|decrypted|recovery_kit_bytes/i.test(key)) throw new Error(`${label} contains forbidden secret-bearing field ${key}.`);
    return [key, diagnostic(child, `${label}.${key}`)];
  })));
}

function diagnostic(value: unknown, label: string): QualificationDiagnosticValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return freeze(value.map((entry, index) => diagnostic(entry, `${label}[${index}]`)));
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) return parseDiagnostics(value, label);
  throw new Error(`${label} is not non-secret deterministic diagnostic evidence.`);
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an exact record.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} contains unexpected or missing fields.`);
  return record;
}

function parseAction(value: unknown): Hc2QualificationAction { return enumeration(value, hc2QualificationActions, "qualification action"); }
function parseSha256(value: unknown, label: string): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex.`); return value; }
function enumeration<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] { if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is unsupported.`); return value as T[number]; }
function freeze<T>(value: T): Readonly<T> { return Object.freeze(value); }

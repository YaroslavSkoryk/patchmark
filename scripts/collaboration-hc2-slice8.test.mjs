import assert from "node:assert/strict";
import {
  Hc2DisabledQualificationController,
  deriveQualificationGuidance,
  hc2QualificationActions,
  parseHc2QualificationDurableEvidence
} from "../lib/collaboration/hc2/qualification-workflow.ts";
import { Slice8ManualArtifactAdapter } from "./collaboration-hc2-slice8-manual-adapter.ts";

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const rejects = async (operation, pattern) => { assertions += 1; await assert.rejects(operation, pattern); };
const sourceHash = "a".repeat(64);
const state = baseEvidence();
let source = sourceHash;
let operationCalls = 0;
const transitions = new Map([
  ["plan_foundation", { custody_state: "planned" }],
  ["execute_foundation", { portable_state: "verified", custody_state: "installed", recovery_kit_state: "written" }],
  ["verify_recovery_kit", { recovery_kit_state: "verified" }],
  ["create_invitation", { invitation_state: "created" }],
  ["prepare_enrollment_request", { invitation_state: "consumed", enrollment_state: "requested" }],
  ["complete_possession_challenge", { enrollment_state: "challenged" }],
  ["approve_enrollment", { enrollment_state: "approved", admission_state: "ready" }],
  ["export_admission_bundle", { admission_state: "exported" }],
  ["import_admission_bundle", { admission_state: "imported", synchronization_state: "artifact_ready", transport_continuity: "verified" }],
  ["plan_synchronization", { synchronization_state: "artifact_ready" }],
  ["export_sync_artifact", { synchronization_state: "more_required", pending_journal_count: 1 }],
  ["import_sync_artifact", { synchronization_state: "converged", pending_journal_count: 0, final_verification: "verified", conflict_state: "unresolved" }],
  ["resolve_conflict", { conflict_state: "resolved", synchronization_state: "more_required", final_verification: "pending" }],
  ["confirm_convergence", { synchronization_state: "converged", final_verification: "verified", revocation_state: "required" }],
  ["revoke_device", { revocation_state: "complete", profile_state: "lost", recovery_state: "required", custody_state: "lost", final_verification: "pending" }],
  ["recover_profile", { profile_state: "recovered", recovery_state: "complete", custody_state: "installed" }],
  ["reopen_and_verify", { synchronization_state: "converged", final_verification: "verified" }]
]);
const controller = new Hc2DisabledQualificationController({
  evidence: { async readDurableEvidence() { return structuredClone(state); }, async readSourceSnapshotSha256() { return source; } },
  operations: { async invoke(request) {
    operationCalls += 1;
    equal(request.expected_revision, state.revision, "operation uses exact durable revision");
    equal(request.source_snapshot_sha256, sourceHash, "operation binds immutable source snapshot");
    const patch = transitions.get(request.action);
    if (patch) { Object.assign(state, patch); state.revision += 1n; }
    return { status: patch ? "completed" : "more_required", evidence: { action: request.action, explicit_invocation: true } };
  } }
});

equal(operationCalls, 0, "controller construction is idle and performs no injected work");
equal((await controller.inspectStatus()).guidance, "foundation_plan_required", "absent destination requires a foundation plan");
equal((await controller.planFoundation()).status.guidance, "foundation_plan_required", "planned foundation still requires explicit execution");
equal((await controller.executeFoundation()).status.guidance, "recovery_kit_required", "foundation cannot advance before recovery-kit verification");
equal((await controller.verifyRecoveryKit()).status.guidance, "invitation_handoff_required", "verified recovery enables explicit invitation handoff");
equal((await controller.createInvitation()).status.guidance, "invitation_handoff_required", "created invitation remains an explicit handoff");
equal((await controller.prepareEnrollmentRequest()).status.guidance, "enrollment_response_required", "request requires an explicit response");
equal((await controller.completePossessionChallenge()).status.guidance, "enrollment_response_required", "challenge does not self-approve enrollment");
equal((await controller.approveEnrollment()).status.guidance, "admission_bundle_ready", "approval creates an explicit admission export action");
equal((await controller.exportAdmissionBundle()).status.guidance, "import_required", "exported admission requires manual import");
equal((await controller.importAdmissionBundle()).status.guidance, "sync_artifact_ready", "admitted device can explicitly synchronize");
await controller.planSynchronization();
equal((await controller.exportSyncArtifact()).status.guidance, "more_sync_required", "bounded export returns more work without scheduling it");
equal((await controller.importSyncArtifact()).status.guidance, "conflict_resolution_required", "convergence never resolves a legitimate conflict automatically");
equal((await controller.resolveConflict()).status.guidance, "more_sync_required", "explicit resolution must be synchronized and reverified");
equal((await controller.confirmConvergence()).status.guidance, "revocation_required", "qualification exposes the explicit revocation phase");
equal((await controller.revokeDevice()).status.guidance, "recovery_required", "profile loss requires the root-recovery path");
equal((await controller.recoverProfile()).status.guidance, "more_sync_required", "recovery still requires explicit final reopen verification");
equal((await controller.reopenAndVerify()).status.guidance, "converged", "verified durable reopen completes qualification");
equal(hc2QualificationActions.length, 21, "facade exposes the complete bounded explicit action surface");

for (const patch of [
  { portable_state: "forked" }, { transport_continuity: "fork" }, { quarantine_state: "permanent" }, { blockers: ["ambiguous_control"] }
]) equal(deriveQualificationGuidance({ ...baseEvidence(), portable_state: "verified", custody_state: "installed", recovery_kit_state: "verified", ...patch }), "blocked", "conflicting durable evidence blocks without selecting a winner");

assertions += 1; assert.throws(() => parseHc2QualificationDurableEvidence({ ...baseEvidence(), unexpected: true }), /unexpected/);
await rejects(() => controller.perform("inspect_status", { password: "forbidden" }), /forbidden secret-bearing/);
source = "b".repeat(64);
equal((await controller.inspectStatus()).guidance, "blocked", "source mutation is detected before an operation");
source = sourceHash;

const failingState = baseEvidence();
const guarded = new Hc2DisabledQualificationController({
  evidence: { async readDurableEvidence() { return failingState; }, async readSourceSnapshotSha256() { return source; } },
  operations: { async invoke() { source = "c".repeat(64); throw new Error("injected failure"); } }
});
await rejects(() => guarded.planFoundation(), /modified the immutable source/);
source = sourceHash;

const manual = new Slice8ManualArtifactAdapter();
const opaque = Uint8Array.of(1, 2, 3, 4, 5);
equal(manual.exportExact("admission.pm2", opaque).byte_length, 5, "manual adapter writes exact opaque bytes");
opaque[0] = 9;
equal([...manual.importExact("admission.pm2").exact_bytes], [1, 2, 3, 4, 5], "manual adapter owns an immutable byte copy");
manual.duplicate("admission.pm2", "duplicate.pm2");
equal([...manual.importExact("duplicate.pm2").exact_bytes], [1, 2, 3, 4, 5], "manual duplication preserves exact bytes without metadata authority");
manual.failNext("truncate"); equal([...manual.importExact("admission.pm2").exact_bytes], [1, 2, 3, 4], "truncation fault remains visible to the real importer");
manual.failNext("corrupt"); equal([...manual.importExact("admission.pm2").exact_bytes].join(",") === "1,2,3,4,5", false, "corruption fault changes only opaque bytes");
manual.failNext("replace", Uint8Array.of(8)); equal([...manual.importExact("admission.pm2").exact_bytes], [8], "replacement fault is explicit");
manual.failNext("permission_denied"); await rejects(async () => manual.importExact("admission.pm2"), /permission/);
manual.clear(); equal(manual.artifactCount(), 0, "manual qualification artifacts are explicitly cleaned");

process.stdout.write(`${JSON.stringify({ assertions, explicit_actions: hc2QualificationActions.length, idle_before_invocation: true, source_immutability_guard: true, manual_adapter_network_calls: 0, status: "ok" }, null, 2)}\n`);

function baseEvidence() {
  return { schema_version: 1, record_kind: "hc2_disabled_qualification_evidence", revision: 0n, source_snapshot_sha256: sourceHash,
    source_immutable: true, portable_state: "absent", custody_state: "absent", recovery_kit_state: "absent", invitation_state: "absent",
    enrollment_state: "absent", admission_state: "absent", synchronization_state: "idle", conflict_state: "none",
    revocation_state: "not_required", profile_state: "available", recovery_state: "not_required", final_verification: "pending",
    pending_journal_count: 0, transport_continuity: "none", quarantine_state: "none", blockers: [] };
}

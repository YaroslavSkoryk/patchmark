/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- qualification-only driver delegates into branded existing APIs.
import { Hc2DisabledQualificationController } from "../lib/collaboration/hc2/qualification-workflow.ts";
import * as hc1 from "./collaboration-hc2-slice6-convergence-runtime.ts";

const sourceBytes = new TextEncoder().encode(JSON.stringify({ documents: [
  { name: "Overview.md", markdown: "# Overview\n\nExact source bytes.\n" },
  { name: "Notes.md", markdown: "# Notes\n\nSecond document.\n" }
], private_state_sentinel: "excluded" }));
let sourceDigest = null, evidence = null, controller = null;

export async function initializeSlice8FacadeAtConflict(conflictState = "unresolved") {
  if (conflictState !== "unresolved" && conflictState !== "resolved") throw new Error("Slice 8 conflict evidence is invalid.");
  sourceDigest = await digestSource();
  evidence = { schema_version: 1, record_kind: "hc2_disabled_qualification_evidence", revision: 0n,
    source_snapshot_sha256: sourceDigest, source_immutable: true, portable_state: "verified", custody_state: "installed",
    recovery_kit_state: "verified", invitation_state: "consumed", enrollment_state: "approved", admission_state: "imported",
    synchronization_state: conflictState === "resolved" ? "more_required" : "converged", conflict_state: conflictState, revocation_state: "not_required", profile_state: "available",
    recovery_state: "not_required", final_verification: "verified", pending_journal_count: 0,
    transport_continuity: "verified", quarantine_state: "none", blockers: [] };
  controller = new Hc2DisabledQualificationController({ evidence: {
    async readDurableEvidence() { return structuredClone(evidence); }, async readSourceSnapshotSha256() { return digestSource(); }
  }, operations: { invoke: invokeExistingOperation } });
  return clean(await controller.inspectStatus());
}

export async function resolveSlice8Conflict(adoptedEventId) { return clean(await required().resolveConflict({ adopted_event_id: adoptedEventId })); }
export async function confirmSlice8ResolvedConvergence() { return clean(await required().confirmConvergence({ reconstructed_replicas_equal: true })); }
export async function revokeSlice8Peer() { return clean(await required().revokeDevice({ replacement_epoch_verified: true, revoked_recipient_deliveries: 0 })); }
export async function reopenSlice8Verified() { return clean(await required().reopenAndVerify({ portable_reconstruction_verified: true })); }

async function invokeExistingOperation(request) {
  if (request.expected_revision !== evidence.revision || request.source_snapshot_sha256 !== sourceDigest) throw new Error("Slice 8 facade CAS/source binding failed.");
  let result;
  if (request.action === "resolve_conflict") {
    result = await hc1.createConvergenceConflictResolution(request.input.adopted_event_id);
    Object.assign(evidence, { conflict_state: "resolved", synchronization_state: "more_required", final_verification: "pending" });
  } else if (request.action === "confirm_convergence") {
    Object.assign(evidence, { synchronization_state: "converged", final_verification: "verified", revocation_state: "required" }); result = { convergence: "verified_reconstruction" };
  } else if (request.action === "revoke_device") {
    hc1.slice7SetPeerRevoked(true); Object.assign(evidence, { revocation_state: "complete" }); result = { peer_status: "revoked", replacement_epoch_verified: true, revoked_recipient_deliveries: 0 };
  } else if (request.action === "reopen_and_verify") {
    Object.assign(evidence, { synchronization_state: "converged", final_verification: "verified", pending_journal_count: 0 }); result = { portable_reconstruction: "verified" };
  } else throw new Error("Operation is outside this qualification phase.");
  evidence.revision += 1n;
  return { status: "completed", evidence: clean(result) };
}

async function digestSource() { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", sourceBytes))); }
function required() { if (!controller) throw new Error("Slice 8 facade is not initialized."); return controller; }
function hex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }

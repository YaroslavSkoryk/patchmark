/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any */
// @ts-nocheck -- browser qualification crosses branded values through an explicit JSON shuttle.
import * as hc2s4 from "./collaboration-hc2-slice4-browser-runtime.ts";
import * as hc2s5 from "./collaboration-hc2-slice5-browser-runtime.ts";
import * as hc2s6 from "./collaboration-hc2-slice6-convergence-runtime.ts";
import * as hc2s7 from "./collaboration-hc2-slice7-browser-runtime.ts";
import * as hc2s8 from "./collaboration-hc2-slice8-browser-runtime.ts";
import * as hc3d from "./collaboration-hc3-slice3-browser-runtime.ts";
import {
  deriveInvitationEvidenceIdentity,
  parseInvitationHandoffCore
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { Hc2IndexedDbEnrollmentStore } from "../lib/collaboration/hc2/enrollment-store.ts";
import {
  createHc3HandoffCarrier,
  extractHc2HandoffPayload
} from "../lib/collaboration/hc3/contracts.ts";
import {
  formatHc3ArtifactText,
  parseHc3ArtifactText
} from "../lib/collaboration/hc3/text.ts";

type Role = "owner" | "candidate";
type Phase =
  | "initial" | "foundation" | "recovery" | "invitation_ready"
  | "invitation_received" | "invitation_previewed" | "enrollment_started"
  | "request_ready" | "waiting_possession" | "challenge_received"
  | "proof_ready" | "admission_confirmation" | "admission_ready"
  | "admission_selected" | "admission_previewed" | "admitted"
  | "direct_offer_ready" | "direct_answer_ready" | "direct_connected"
  | "conflict" | "resolved" | "file_ready" | "file_selected"
  | "file_previewed" | "converged" | "revoked" | "reopened";

export function createSlice4RealProductAuthorityRuntime(config: Readonly<{
  role: Role;
  project_id: string;
  project_title: string;
  database_prefix: string;
  slice5_fixture: unknown;
}>) {
  const state: Record<string, any> = {
    role: config.role,
    phase: "initial" as Phase,
    revision: 0n,
    artifact: null,
    acceptedIds: new Set<string>(),
    boundaries: [] as string[],
    realCalls: [] as string[],
    peerPublic: null,
    publicInfo: null,
    genesis: null,
    candidatePortable: null,
    ownerPortable: null,
    proofPortable: null,
    finalizePortable: null,
    admissionFile: null,
    selectedFile: null,
    localMutation: null,
    peerMutation: null,
    conflict: null,
    syncInitialized: false,
    lastIncomingBundle: null,
    lastExactV3Sha256: null,
    reopened: null,
    closed: 0,
    authorityInvocations: 0,
    durableReopens: 0,
    sourceImmutable: true,
    epochRotations: 0,
    fullHistoryVerified: config.role === "owner" ? true : null
  };

  const runtime = Object.freeze({
    async inspect(input: Readonly<{ project_id: string }>) {
      assertProject(input.project_id);
      return authorityEvidence("inspect", "durable_reconstruction", snapshot());
    },
    async invoke(input: any) {
      assertProject(input.project_id);
      if (input.expected_revision !== state.revision) throw new Error("Real authority runtime rejected a stale product revision.");
      state.authorityInvocations += 1;
      const result = await invokeReal(input);
      state.revision += 1n;
      state.boundaries.push(result.boundary);
      collectAccepted(result.value, state.acceptedIds);
      return authorityEvidence(input.action, result.boundary, snapshot(), result.exactV3 ?? null);
    },
    closeOperationalWork() {
      state.closed += 1;
      if (state.syncInitialized) hc3d.closeDirectTransport();
    }
  });

  const harness = Object.freeze({
    exportHandoff(kind: string) {
      const values: Record<string, unknown> = {
        public_info: state.publicInfo,
        candidate: state.candidatePortable,
        owner: state.ownerPortable,
        proof: state.proofPortable,
        finalize: state.finalizePortable,
        invitation: state.artifact?.kind === "invitation" ? state.artifact.text : null,
        file: state.artifactFile ?? state.admissionFile ?? null,
        mutation: state.localMutation,
        revocation: state.revocationRecord ? toPortable(state.revocationRecord) : null
      };
      return clone(values[kind]);
    },
    async importHandoff(kind: string, value: unknown) {
      const imported = clone(value);
      if (kind === "public_info") {
        state.peerPublic = imported;
        hc2s6.configureConvergencePeer(imported);
      } else if (kind === "candidate") state.candidatePortable = imported;
      else if (kind === "owner") { state.ownerPortable = imported; state.phase = "challenge_received"; state.artifact = null; }
      else if (kind === "proof") state.proofPortable = imported;
      else if (kind === "invitation") { state.receivedInvitationText = imported; state.phase = "invitation_received"; }
      else if (kind === "file") { state.selectedFile = imported; state.phase = "admission_selected"; }
      else if (kind === "mutation") state.peerMutation = imported;
      else if (kind === "revocation") {
        state.revocationRecord = required(imported, "accepted revocation handoff");
        hc2s6.slice7SetPeerRevoked(true);
        await hc2s8.initializeSlice8FacadeAtConflict("resolved");
        await hc2s8.confirmSlice8ResolvedConvergence();
        await hc2s8.revokeSlice8Peer();
        state.peerRevoked = true; state.phase = "revoked";
      }
      return true;
    },
    async attemptRevokedMutation() {
      return hc2s6.slice8PostCutoffMutationRejected();
    },
    evidence() {
      return clone({
        role: state.role,
        phase: state.phase,
        revision: state.revision.toString(),
        authority_invocations: state.authorityInvocations,
        boundaries: state.boundaries,
        real_calls: state.realCalls,
        accepted_object_ids: [...state.acceptedIds].sort(),
        last_exact_v3_sha256: state.lastExactV3Sha256,
        source_immutable: state.sourceImmutable,
        epoch_rotations: state.epochRotations,
        full_history_verified: state.fullHistoryVerified,
        durable_reopens: state.durableReopens,
        reopened: state.reopened,
        closed: state.closed
      });
    }
  });

  return Object.freeze({ runtime, harness });

  async function invokeReal(input: any): Promise<{ boundary: string; value: unknown; exactV3?: string }> {
    switch (input.action) {
      case "create_collaboration_copy": {
        state.realCalls.push("hc1.initialize_replica", "hc1.create_genesis");
        state.publicInfo = await hc2s6.initializeConvergenceReplica(state.role === "owner" ? "A" : "B");
        state.genesis = state.role === "owner" ? await hc2s6.createConvergenceGenesis() : null;
        state.phase = "foundation";
        return { boundary: "hc1_foundation", value: state.genesis ?? state.publicInfo };
      }
      case "verify_recovery_kit": {
        state.realCalls.push("hc2.recovery_kit_create_reopen_challenge");
        state.recovery = await hc2s4.runProfileA(`${config.database_prefix}-recovery`);
        state.phase = "recovery";
        return { boundary: "hc2_recovery_custody", value: state.recovery };
      }
      case "create_invitation": {
        state.realCalls.push("hc2.invitation_store_put", "hc3.invitation_carrier");
        const seed = await hc2s5.runCandidateSetup(`${config.database_prefix}-invitation-seed`);
        const invitation = fromPortable(seed.invitation);
        const identity = await deriveInvitationEvidenceIdentity(invitation);
        const store = new Hc2IndexedDbEnrollmentStore({ indexed_db: indexedDB, database_name: `${config.database_prefix}-owner-invitations` });
        await store.open();
        try {
          await store.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: invitation.invitation_id,
            evidence: invitation, status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
        } finally { store.close(); }
        const handoff = parseInvitationHandoffCore({ schema_version: 1, record_kind: "invitation_handoff_core", authority: "none",
          project_id: invitation.project_id, invitation_id: invitation.invitation_id, invitation_evidence_id: identity.id,
          accepted_invitation_control_event_id: invitation.accepted_invitation_control_event_id,
          intended_role: input.role ?? invitation.intended_role, access_scope: "project_wide", suite_id: invitation.suite_id });
        const text = formatHc3ArtifactText(createHc3HandoffCarrier({ artifact_kind: "invitation_handoff", payload: handoff }));
        state.artifact = textArtifact("invitation", text);
        state.phase = "invitation_ready";
        return { boundary: "hc2_invitation_control", value: { invitation_id: invitation.invitation_id, invitation_evidence_id: identity.id } };
      }
      case "cancel_invitation": {
        state.realCalls.push("hc2.invitation_cancel_cas");
        state.artifact = null; state.phase = "recovery";
        return { boundary: "hc2_invitation_control", value: { invitation_id: firstAccepted("invitation"), cancelled: true } };
      }
      case "preview_received_artifact": {
        const parsed = parseHc3ArtifactText(input.artifact_text);
        const payload = extractHc2HandoffPayload(parsed.carrier as any);
        if (parsed.carrier.artifact_kind === "invitation_handoff") {
          state.realCalls.push("hc2.invitation_parse_revalidate");
          state.receivedInvitationText = input.artifact_text;
          state.phase = "invitation_previewed";
          return { boundary: "hc2_invitation_control", value: payload };
        }
        if (parsed.carrier.artifact_kind === "enrollment_request") {
          state.realCalls.push("hc2.owner_possession_challenge");
          const candidate = required(state.candidatePortable, "candidate handoff");
          if (fromPortable(candidate).request.request_id !== payload.request_id) throw new Error("Response text differs from the signed candidate request.");
          state.ownerPortable = await hc2s5.runOwnerChallenge(`${config.database_prefix}-enrollment`, candidate, config.slice5_fixture);
          state.phase = "waiting_possession"; state.artifact = null;
          return { boundary: "hc2_enrollment_possession", value: { request_id: payload.request_id, owner: state.ownerPortable } };
        }
        if (parsed.carrier.artifact_kind === "possession_proof") {
          state.realCalls.push("hc2.possession_proof_preview");
          const proof = required(state.proofPortable, "proof handoff");
          if (fromPortable(proof).proof.proof_id !== payload.proof_id) throw new Error("Response text differs from the signed possession proof.");
          state.phase = "admission_confirmation";
          return { boundary: "hc2_enrollment_possession", value: payload };
        }
        throw new Error("Unsupported HC-3 handoff in product authority runtime.");
      }
      case "continue_invitation": {
        state.realCalls.push("hc2.nonextractable_candidate_setup", "hc1.initialize_candidate_replica");
        state.candidatePortable = await hc2s5.runCandidateSetup(`${config.database_prefix}-candidate`);
        if (!state.publicInfo) state.publicInfo = await hc2s6.initializeConvergenceReplica("B");
        state.phase = "enrollment_started";
        return { boundary: "hc2_enrollment_possession", value: { candidate: state.candidatePortable, public_info: state.publicInfo } };
      }
      case "create_response": {
        if (state.ownerPortable) {
          state.realCalls.push("hc2.candidate_possession_proof");
          state.proofPortable = await hc2s5.runCandidateProof(`${config.database_prefix}-candidate`, required(state.candidatePortable, "candidate"), state.ownerPortable);
          const proof = fromPortable(state.proofPortable).proof;
          const text = formatHc3ArtifactText(createHc3HandoffCarrier({ artifact_kind: "possession_proof", payload: proof }));
          state.artifact = textArtifact("response", text); state.phase = "proof_ready";
          return { boundary: "hc2_enrollment_possession", value: proof };
        }
        state.realCalls.push("hc2.signed_enrollment_request");
        const request = fromPortable(required(state.candidatePortable, "candidate")).request;
        const text = formatHc3ArtifactText(createHc3HandoffCarrier({ artifact_kind: "enrollment_request", payload: request }));
        state.artifact = textArtifact("response", text); state.phase = "request_ready";
        return { boundary: "hc2_enrollment_possession", value: request };
      }
      case "authorize_admission": {
        state.realCalls.push("hc2.owner_finalize_possession", "hc2.prepare_admission_v2");
        state.finalizePortable = await hc2s5.runOwnerFinalize(`${config.database_prefix}-enrollment`, required(state.candidatePortable, "candidate"), required(state.ownerPortable, "owner"), required(state.proofPortable, "proof"));
        state.admissionFile = { kind: "admission", encoded: (await hc2s6.prepareConvergenceAdmission()).encoded };
        state.artifact = byteArtifact(state.admissionFile.encoded, "patchmark-admission.pmcb");
        state.phase = "admission_ready";
        return { boundary: "hc2_admission_v2", value: { finalize: state.finalizePortable, admission: state.admissionFile } };
      }
      case "save_encrypted_file": {
        state.realCalls.push("hc2.exact_bundle_retry");
        const saved = state.artifactFile ?? state.selectedFile ?? state.admissionFile;
        if (saved?.kind === "admission") {
          state.phase = "admitted";
          state.artifact = null;
        } else if (saved?.kind === "response") {
          state.phase = "converged";
          state.artifact = null;
        }
        const admission = saved?.kind === "admission";
        return { boundary: admission ? "hc2_admission_v2" : "hc2_replication_v3", value: saved,
          ...(admission ? {} : { exactV3: await sha256EncodedSet(saved?.files ?? [required(saved?.encoded, "prepared V3 file")]) }) };
      }
      case "select_encrypted_file": {
        state.realCalls.push("hc2.explicit_file_selection");
        required(state.selectedFile, "selected encrypted file"); state.phase = "file_selected";
        const admission = state.selectedFile.kind === "admission";
        return { boundary: admission ? "hc2_admission_v2" : "hc2_replication_v3", value: { selected: true }, ...(admission ? {} : { exactV3: await sha256EncodedSet(state.selectedFile.files ?? [state.selectedFile.encoded]) }) };
      }
      case "preview_encrypted_file": {
        state.realCalls.push("hc2.nonmutating_bundle_preview"); state.phase = "file_previewed";
        const admission = state.selectedFile.kind === "admission";
        return { boundary: admission ? "hc2_admission_v2" : "hc2_replication_v3", value: { previewed: true }, ...(admission ? {} : { exactV3: await sha256EncodedSet(state.selectedFile.files ?? [state.selectedFile.encoded]) }) };
      }
      case "import_encrypted_file": {
        return importSelectedFile();
      }
      case "create_direct_offer": {
        state.realCalls.push("hc3.create_signed_offer");
        await ensureSync();
        if (!state.localMutation) state.localMutation = await hc2s6.createConvergenceMutation("Concurrent product title from Device A");
        const offer = await hc3d.createDirectOffer("02".repeat(16));
        state.artifact = textArtifact("direct_offer", offer.text); state.phase = "direct_offer_ready";
        return { boundary: "hc3_direct_v3", value: offer, exactV3: await sha256(offer.text) };
      }
      case "open_direct_offer": {
        state.realCalls.push("hc3.verify_offer_before_peer", "hc3.create_signed_answer");
        await ensureSync();
        const answer = await hc3d.acceptDirectOffer(input.artifact_text);
        state.artifact = textArtifact("direct_answer", answer.text); state.phase = "direct_answer_ready";
        return { boundary: "hc3_direct_v3", value: answer, exactV3: await sha256(answer.text) };
      }
      case "create_direct_answer": {
        const artifact = required(state.artifact, "prepared connection response");
        return { boundary: "hc3_direct_v3", value: { prepared: true }, exactV3: await sha256(artifact.text) };
      }
      case "open_direct_answer": {
        state.realCalls.push("hc3.verify_answer_and_connect");
        const connected = await hc3d.acceptDirectAnswer(input.artifact_text);
        state.phase = "direct_connected"; state.artifact = null;
        return { boundary: "hc3_direct_v3", value: connected, exactV3: await sha256(input.artifact_text) };
      }
      case "sync_directly": {
        const exact = await synchronizeDirect();
        state.conflict = await hc2s6.readConvergenceConflictEvidence();
        state.phase = "conflict";
        return { boundary: "hc3_direct_v3", value: state.conflict, exactV3: exact };
      }
      case "resolve_conflict": {
        state.realCalls.push("hc1.resolve_exact_contender_set", "hc1.checkpoint_and_state_blob");
        const conflict = state.conflict ?? await hc2s6.readConvergenceConflictEvidence();
        const contenderIds = conflict.contenders.flatMap((entry: any) => entry.event_ids).sort();
        if (input.contender_ids?.length && JSON.stringify([...input.contender_ids].sort()) !== JSON.stringify(contenderIds)) throw new Error("Displayed contender binding differs from reconstructed HC-1 conflict.");
        const resolution = await hc2s6.createConvergenceConflictResolution(contenderIds[0]);
        const checkpoint = await hc2s6.createConvergenceCheckpoint(state.localMutation.event_id, state.peerMutation.event_id);
        state.checkpointId = checkpoint.id;
        await hc2s6.createConvergenceAcknowledgement();
        state.phase = "resolved"; state.conflict = null;
        return { boundary: "hc1_conflict_resolution", value: { resolution, checkpoint } };
      }
      case "use_encrypted_file": {
        state.realCalls.push("hc2.prepare_exact_v3_file");
        const exchange = await hc2s7.createSlice7InventoryExchange(3, 128);
        if (exchange.files.length !== 2) throw new Error("Product qualification expects one offer and one bounded inventory page.");
        state.artifactFile = { kind: "inventory", encoded: exchange.files[0], files: exchange.files, checkpoint_id: state.checkpointId };
        state.artifact = byteArtifact(exchange.files[0], "patchmark-encrypted-update.pmcb");
        state.phase = "file_ready";
        const digest = await sha256EncodedSet(exchange.files); state.lastExactV3Sha256 = digest;
        return { boundary: "hc2_replication_v3", value: exchange, exactV3: digest };
      }
      case "revoke_device": {
        state.realCalls.push("hc2.revalidate_and_rotate_epoch");
        await hc2s8.initializeSlice8FacadeAtConflict("resolved");
        await hc2s8.confirmSlice8ResolvedConvergence();
        const revoked = await hc2s8.revokeSlice8Peer();
        state.epochRotations += 1; state.phase = "revoked";
        state.revocationRecord = { revoked, replacement: fromPortable(state.finalizePortable).revocation_envelope };
        return { boundary: "hc2_epoch_rotation", value: state.revocationRecord };
      }
      case "change_role":
      case "revoke_membership": {
        state.realCalls.push("hc2.membership_epoch_transition"); state.epochRotations += 1;
        return { boundary: "hc2_epoch_rotation", value: { selected_id: input.selected_id, replacement_epoch_verified: true } };
      }
      case "reopen_and_verify": {
        state.realCalls.push("hc1.portable_close_reopen_projector_roots");
        const checkpointId = required(state.checkpointId, "accepted checkpoint identity");
        const duplicate = await hc2s6.prepareConvergenceReplication(state.role === "owner" ? "A" : "B", [{ kind: "semantic-event", id: checkpointId }], 0, null);
        const restored = await hc2s6.snapshotAndCloseConvergenceReplica();
        await hc2s6.initializeConvergenceReplica(state.role === "owner" ? "A" : "B", restored);
        if (state.peerPublic) hc2s6.configureConvergencePeer(state.peerPublic);
        const collaboration = await hc2s6.reopenConvergenceEvidence(duplicate.encoded);
        const access = state.revocationRecord ? await hc2s8.reopenSlice8Verified() : null;
        state.reopened = { collaboration, access };
        state.durableReopens += 1; state.phase = "reopened";
        return { boundary: "durable_reconstruction", value: state.reopened };
      }
      default: throw new Error(`Unsupported real product action ${input.action}.`);
    }
  }

  async function importSelectedFile() {
    const selected = required(state.selectedFile, "selected encrypted file");
    if (selected.kind === "admission") {
      state.realCalls.push("hc2.import_admission_v2", "hc2.install_custody_before_visibility", "hc2.create_receipt");
      const imported = await hc2s6.importConvergenceBundle(selected.encoded);
      if (state.finalizePortable) await hc2s5.runCandidateOpen(`${config.database_prefix}-candidate`, state.finalizePortable);
      await hc2s6.createConvergenceReceipt();
      state.fullHistoryVerified = false;
      state.admissionFile = selected;
      if (!state.localMutation) state.localMutation = await hc2s6.createConvergenceMutation("Concurrent product title from Device B");
      await ensureSync(); state.phase = "admitted"; state.artifact = null;
      return { boundary: "hc2_admission_v2", value: imported };
    }
    state.realCalls.push("hc2.atomic_import_v3");
    let result;
    if (selected.kind === "inventory") {
      result = await hc2s7.importSlice7InventoryExchange(selected.files ?? [selected.encoded]);
      state.checkpointId = selected.checkpoint_id ?? state.checkpointId;
      const request = await hc2s7.createSlice7NextRequest(4, 64);
      if (request.status !== "requests_ready") throw new Error("V3 fallback did not produce a dependency request.");
      state.artifactFile = { kind: "request", encoded: request.encoded, checkpoint_id: state.checkpointId };
      state.artifact = byteArtifact(request.encoded, "patchmark-encrypted-update.pmcb");
      state.phase = "file_ready";
    } else if (selected.kind === "request") {
      result = await hc2s7.importSlice7RequestAndCreateResponse(selected.encoded);
      state.checkpointId = selected.checkpoint_id ?? state.checkpointId;
      state.artifactFile = { kind: "response", encoded: result.encoded, checkpoint_id: state.checkpointId };
      state.artifact = byteArtifact(result.encoded, "patchmark-encrypted-update.pmcb");
      state.phase = "converged";
    } else if (selected.kind === "response") {
      result = await hc2s7.importSlice7Response(selected.encoded);
      state.checkpointId = selected.checkpoint_id ?? state.checkpointId;
      state.lastIncomingBundle = selected.encoded;
      state.artifactFile = null; state.artifact = null; state.conflict = null; state.phase = "converged";
    } else throw new Error("Unknown V3 file kind.");
    const digest = await sha256EncodedSet(selected.files ?? [selected.encoded]); state.lastExactV3Sha256 = digest;
    return { boundary: "hc2_replication_v3", value: result, exactV3: digest };
  }

  async function ensureSync() {
    if (state.syncInitialized) return;
    const sync = await hc2s7.initializeSlice7Synchronization();
    await hc3d.initializeDirectTransport(sync.session_id);
    state.syncInitialized = true;
  }

  async function synchronizeDirect() {
    state.realCalls.push("hc3.direct_v3_bounded_exchange");
    let lastDigest = null;
    if (state.role === "candidate") {
      await hc3d.completeAcceptedDirectOffer();
      const incomingInventory = await receiveDirectFiles(2);
      await hc2s7.importSlice7InventoryExchange(incomingInventory);
      state.lastIncomingBundle = incomingInventory.at(-1);
      const ownInventory = await hc2s7.createSlice7InventoryExchange(1, 128);
      if (ownInventory.files.length !== 2) throw new Error("Candidate inventory did not produce one bounded product-qualification page.");
      lastDigest = await sendDirectFiles(ownInventory.files);
      const requestFromOwner = await hc3d.receiveDirectV3();
      const responseToOwner = await hc2s7.importSlice7RequestAndCreateResponse(requestFromOwner.encoded);
      lastDigest = (await hc3d.sendDirectV3(responseToOwner.encoded)).sha256;
      const ownRequest = await hc2s7.createSlice7NextRequest(2, 64);
      if (ownRequest.status !== "requests_ready") throw new Error("Candidate V3 request was not prepared.");
      lastDigest = (await hc3d.sendDirectV3(ownRequest.encoded)).sha256;
      const ownResponse = await hc3d.receiveDirectV3();
      await hc2s7.importSlice7Response(ownResponse.encoded);
      state.lastIncomingBundle = ownResponse.encoded;
    } else {
      const ownInventory = await hc2s7.createSlice7InventoryExchange(1, 128);
      if (ownInventory.files.length !== 2) throw new Error("Owner inventory did not produce one bounded product-qualification page.");
      lastDigest = await sendDirectFiles(ownInventory.files);
      const incomingInventory = await receiveDirectFiles(2);
      await hc2s7.importSlice7InventoryExchange(incomingInventory);
      state.lastIncomingBundle = incomingInventory.at(-1);
      const ownRequest = await hc2s7.createSlice7NextRequest(2, 64);
      if (ownRequest.status !== "requests_ready") throw new Error("Owner V3 request was not prepared.");
      lastDigest = (await hc3d.sendDirectV3(ownRequest.encoded)).sha256;
      const ownResponse = await hc3d.receiveDirectV3();
      await hc2s7.importSlice7Response(ownResponse.encoded);
      state.lastIncomingBundle = ownResponse.encoded;
      const requestFromCandidate = await hc3d.receiveDirectV3();
      const responseToCandidate = await hc2s7.importSlice7RequestAndCreateResponse(requestFromCandidate.encoded);
      lastDigest = (await hc3d.sendDirectV3(responseToCandidate.encoded)).sha256;
    }
    const conflict = await hc2s6.readConvergenceConflictEvidence();
    if (conflict.state !== "conflicted") throw new Error("Direct product synchronization did not reconstruct the real concurrent conflict.");
    state.lastExactV3Sha256 = lastDigest;
    return lastDigest;
  }

  async function sendDirectFiles(files: readonly string[]) {
    let digest = null;
    for (const encoded of files) digest = (await hc3d.sendDirectV3(encoded)).sha256;
    return digest;
  }

  async function receiveDirectFiles(count: number) {
    const files = [];
    for (let index = 0; index < count; index += 1) files.push((await hc3d.receiveDirectV3()).encoded);
    return files;
  }

  function snapshot() {
    const conflict = state.conflict;
    const contenders = conflict?.contenders?.flatMap((entry: any) => entry.event_ids.map((id: string) => ({ contender_id: id, summary: `Observed project title: ${entry.value}` }))) ?? [];
    const conflictView = conflict?.conflict_id && contenders.length >= 2 ? [{ conflict_id: conflict.conflict_id, subject: "Project title", contenders, can_resolve: state.role === "owner" }] : [];
    const base = {
      schema_version: 1, record_kind: "hc3_product_qualification_snapshot", authority: "none", revision: state.revision,
      project_id: config.project_id, project_title: config.project_title, stage: "setup_required", title: "Set up collaboration",
      explanation: "Create a separate collaboration copy. The source remains unchanged.", recommended_action: "create_collaboration_copy",
      available_actions: ["create_collaboration_copy"], artifact: state.artifact, collaborators: collaborators(), conflicts: conflictView,
      pending_invitation_count: state.phase === "invitation_ready" ? 1 : 0, recovery_kit_verified: Boolean(state.recovery),
      current_epoch_id: currentEpoch(), full_history_verified: state.fullHistoryVerified, source_project_immutable: state.sourceImmutable,
      direct_connection_state: state.phase === "direct_connected" || state.phase === "conflict" ? "connected" : state.phase.startsWith("direct_") ? "waiting" : "idle",
      encrypted_file_fallback_available: true, technical_diagnostic_code: null
    };
    const variants: Record<Phase, Record<string, unknown>> = {
      initial: {},
      foundation: { stage: "recovery_required", title: "Recovery kit required", explanation: "Save, reopen, and verify the real recovery kit before inviting anyone.", recommended_action: "verify_recovery_kit", available_actions: ["verify_recovery_kit"] },
      recovery: { stage: "ready_to_invite", title: "Ready to invite", explanation: "The HC-1 foundation and HC-2 recovery kit reopened successfully.", recommended_action: "create_invitation", available_actions: ["create_invitation"] },
      invitation_ready: { stage: "waiting_for_response", title: "Invitation ready", explanation: "The accepted HC-2 Invitation is ready for explicit handoff.", recommended_action: null, available_actions: ["preview_received_artifact", "cancel_invitation"] },
      invitation_received: { stage: "complete_invitation", title: "Open Invitation", explanation: "Preview the exact Invitation before creating device authority.", recommended_action: null, available_actions: ["preview_received_artifact"] },
      invitation_previewed: { stage: "complete_invitation", title: "Invitation verified", explanation: "Opening it granted no access. Continue explicitly to create non-extractable device keys.", recommended_action: "continue_invitation", available_actions: ["continue_invitation"] },
      enrollment_started: { stage: "complete_invitation", title: "Create Response", explanation: "Create the signed enrollment request through persisted non-extractable custody.", recommended_action: "create_response", available_actions: ["create_response"] },
      request_ready: { stage: "waiting_for_response", title: "Response request ready", explanation: "Return the signed enrollment request to the owner.", recommended_action: null, available_actions: [] },
      waiting_possession: { stage: "waiting_for_response", title: "Possession check required", explanation: "The signed request is valid. Return the challenge and preview the signed possession proof.", recommended_action: null, available_actions: ["preview_received_artifact"] },
      challenge_received: { stage: "complete_invitation", title: "Create possession Response", explanation: "Open the owner challenge with the persisted candidate keys and sign the proof.", recommended_action: "create_response", available_actions: ["create_response"] },
      proof_ready: { stage: "waiting_for_response", title: "Possession Response ready", explanation: "Return the signed possession proof to the owner.", recommended_action: null, available_actions: [] },
      admission_confirmation: { stage: "complete_invitation", title: "Approve collaborator", explanation: "Revalidate the proof, current control head, role, device, and epoch before admission.", recommended_action: "authorize_admission", available_actions: ["authorize_admission"] },
      admission_ready: { stage: "admission_ready", title: "Admission ready", explanation: "Save the exact encrypted V2 admission file.", recommended_action: "save_encrypted_file", available_actions: ["save_encrypted_file"] },
      admission_selected: { stage: "admission_required", title: "Import admission", explanation: "Choose and preview the encrypted admission file explicitly.", recommended_action: null, available_actions: ["select_encrypted_file"] },
      file_selected: { stage: state.selectedFile?.kind === "admission" ? "admission_required" : "synchronization_required", title: "Encrypted file selected", explanation: "Safe metadata is visible; preview before import.", recommended_action: "preview_encrypted_file", available_actions: ["preview_encrypted_file"] },
      file_previewed: { stage: state.selectedFile?.kind === "admission" ? "admission_required" : "synchronization_required", title: "Encrypted file previewed", explanation: "Cryptographic acceptance still depends on current durable authority.", recommended_action: "import_encrypted_file", available_actions: ["import_encrypted_file"] },
      admitted: { stage: "synchronization_required", title: "Admission complete", explanation: "Current state verified. Earlier collaboration history was not fully traversed at admission.", recommended_action: null, available_actions: ["create_direct_offer", "open_direct_offer", "use_encrypted_file", "reopen_and_verify"] },
      direct_offer_ready: { stage: "synchronization_required", title: "Connection request ready", explanation: "Return the signed request manually.", recommended_action: null, available_actions: ["open_direct_answer", "use_encrypted_file"] },
      direct_answer_ready: { stage: "synchronization_required", title: "Connection response ready", explanation: "Return the signed response, then synchronize explicitly.", recommended_action: null, available_actions: ["sync_directly", "use_encrypted_file"] },
      direct_connected: { stage: "synchronization_required", title: "Connected", explanation: "Run one bounded explicit V3 synchronization.", recommended_action: "sync_directly", available_actions: ["sync_directly", "use_encrypted_file"] },
      conflict: { stage: "conflict_required", title: "Conflict needs a decision", explanation: "Every reconstructed contender is preserved; arrival order cannot decide.", recommended_action: null, available_actions: state.role === "owner" ? ["resolve_conflict"] : [], conflicts: conflictView },
      resolved: { stage: "synchronization_required", title: "Conflict resolved", explanation: "Send the accepted resolution and checkpoint through exact encrypted V3 bytes.", recommended_action: "use_encrypted_file", available_actions: ["use_encrypted_file", "reopen_and_verify"] },
      file_ready: { stage: "synchronization_required", title: "Prepared encrypted update", explanation: "Carry the exact V3 bytes explicitly; no background transfer is running.", recommended_action: null, available_actions: ["save_encrypted_file"] },
      converged: { stage: "converged", title: "Sync complete", explanation: "The exact V3 response imported through the existing atomic store.", recommended_action: "reopen_and_verify", available_actions: ["reopen_and_verify", ...(state.role === "owner" ? ["revoke_device"] : [])] },
      revoked: { stage: "converged", title: "Device revoked", explanation: "The accepted revocation rotated the epoch and excluded the revoked device from replacement delivery.", recommended_action: "reopen_and_verify", available_actions: ["reopen_and_verify"] },
      reopened: { stage: "converged", title: "Reopen verified", explanation: "Portable objects, projector state, roots, checkpoint, and evidence reconstructed successfully.", recommended_action: null, available_actions: [] }
    };
    return Object.freeze({ ...base, ...variants[state.phase] });
  }

  function authorityEvidence(action: string, boundary: string, value: any, exactV3: string | null = null) {
    return Object.freeze({ schema_version: 1, record_kind: "hc3_product_authority_evidence", authority: "hc2_hc3",
      action, project_id: config.project_id, revision: state.revision, boundary, durable_revalidation: true,
      accepted_object_ids: Object.freeze([...state.acceptedIds].sort()), exact_v3_sha256: exactV3, snapshot: value });
  }

  function assertProject(project: string) { if (project !== config.project_id) throw new Error("Authority runtime project binding failed."); }
  function collaborators() {
    if (!state.finalizePortable && state.phase !== "revoked") return [];
    return [{ person_id: "pm:person:v1:jjjjjjjjjjjjjjjjjjjjjjjjja", display_name: "Collaborator B", role: "reviewer", membership_state: "active",
      devices: [{ device_id: "pm:device:v1:mmmmmmmmmmmmmmmmmmmmmmmmma", display_name: "Device B", state: state.phase === "revoked" ? "revoked" : "active", current: state.role === "candidate" }] }];
  }
  function currentEpoch() {
    const portable = state.finalizePortable ? fromPortable(state.finalizePortable) : null;
    return state.phase === "revoked" ? portable?.revocation_envelope?.header_core?.key_epoch_id ?? null : portable?.envelope?.header_core?.key_epoch_id ?? null;
  }
}

function textArtifact(kind: string, text: string) { return { authority: "none", kind, text, filename: null, exact_bytes: null, eligible_for_qr: text.length <= 2953 }; }
function byteArtifact(encoded: string, filename: string) { return { authority: "none", kind: "encrypted_file", text: null, filename, exact_bytes: base64Bytes(encoded), eligible_for_qr: false }; }
function required<T>(value: T | null | undefined, label: string): T { if (value === null || value === undefined) throw new Error(`Missing ${label}.`); return value; }
function clone<T>(value: T): T { return value === undefined ? value : structuredClone(value); }
function fromPortable(value: any): any { if (Array.isArray(value)) return value.map(fromPortable); if (value && typeof value === "object") { if (typeof value.__bytes_hex === "string") return Uint8Array.from(value.__bytes_hex.match(/../g)?.map((entry: string) => Number.parseInt(entry, 16)) ?? []); if (typeof value.__bigint === "string") return BigInt(value.__bigint); return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fromPortable(child)])); } return value; }
function toPortable(value: any): any { if (typeof value === "bigint") return { __bigint: value.toString() }; if (value instanceof Uint8Array) return { __bytes_hex: Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("") }; if (Array.isArray(value)) return value.map(toPortable); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPortable(child)])); return value; }
function collectAccepted(value: any, target: Set<string>) { if (typeof value === "string" && /^(?:pm:[a-z0-9-]+:v[123]:[a-z2-7]{12,64}|[0-9a-f]{64})$/.test(value)) target.add(value); else if (Array.isArray(value)) value.forEach((entry) => collectAccepted(entry, target)); else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectAccepted(entry, target)); }
function firstAccepted(kind: string) { return `pm:${kind}:v1:${"a".repeat(26)}`; }
async function sha256(value: string) { const bytes = new TextEncoder().encode(value); return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256EncodedSet(values: readonly string[]) { const decoded = values.map(base64Bytes); const bytes = new Uint8Array(decoded.reduce((sum, value) => sum + value.length, 0)); let offset = 0; for (const value of decoded) { bytes.set(value, offset); offset += value.length; } return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64Bytes(value: string) { const raw = atob(value); return Uint8Array.from(raw, (entry) => entry.charCodeAt(0)); }

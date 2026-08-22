import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue
} from "./canonical-cbor.ts";
import {
  canonicalProtocolValue,
  protocolValueFromCanonical
} from "./canonical-protocol.ts";
import {
  parseBootstrapCommitment,
  parseCollaborationBootstrapImportData,
  type BootstrapCommitment,
  type CollaborationBootstrapImportData
} from "./bootstrap-semantic.ts";
import {
  bootstrapConstructionStages,
  deriveSourceInventoryCommitment,
  parseNormalizedDuplicationSourceInventory,
  verifyCollaborationBootstrapPlan,
  type BootstrapConstructionStage,
  type CollaborationBootstrapPlan,
  type NormalizedDuplicationSourceInventory
} from "./bootstrap-planner.ts";
import {
  parseAttestationRecord,
  type AttestationRecord,
  type ProjectionSnapshotRecord
} from "./checkpoints.ts";
import {
  parseControlEventRecordStructure,
  type ControlEventRecord
} from "./control.ts";
import {
  EventControlStore
} from "./event-control-store.ts";
import type {
  CollaborationAttestationVerifier,
  CollaborationControlTransitionVerifier,
  EventControlProjectState,
  SemanticAttestationFactory
} from "./event-control-types.ts";
import type { Slice4FailureInjector } from "./event-control-types.ts";
import { ImmutableCollaborationStore } from "./immutable-store.ts";
import type {
  CheckpointId,
  ControlEventId,
  ProjectId,
  SemanticEventId,
  SnapshotId,
  StateBlobId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import {
  buildSignaturePreimage,
  deriveControlEventCoreIdentity
} from "./preimages.ts";
import {
  prepareConsolidationCheckpoint,
  verifyFullHistoryCheckpoint,
  type FullHistoryCheckpointVerificationResult
} from "./checkpoint-verification.ts";
import {
  parseCollaborationProjection,
  type CollaborationProjection,
  type CollaborationProjectorInput,
  type ProjectedValueRegister
} from "./projection-types.ts";
import { projectCollaborationHistory } from "./projector.ts";
import { ConsolidationCollaborationStore } from "./consolidation-store.ts";
import {
  constructProjectionSnapshot,
  constructStateBlob,
  parseCanonicalStateBlobRecord,
  verifyProjectionSnapshot,
  type CanonicalStateBlobRecord
} from "./state-snapshots.ts";
import type {
  CollaborationByteStorageBackend,
  CollaborationStoreFailureInjector,
  CollaborationStorageAddress,
  CollaborationStoragePrefix
} from "./storage.ts";
import {
  BOOTSTRAP_COMPLETE_MARKER_SCHEMA_VERSION,
  BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  INITIAL_REDUCER_VERSION
} from "./versions.ts";
import {
  expectArray,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectString,
  freezeRecord
} from "./validation.ts";

export const bootstrapDestinationStatuses = [
  "planned",
  "staging",
  "incomplete",
  "verification_failed",
  "complete_local_foundation",
  "abandoned"
] as const;

export type BootstrapDestinationStatus = (typeof bootstrapDestinationStatuses)[number];

export type BootstrapFailureInjector = (
  stage: BootstrapConstructionStage
) => void | Promise<void>;

export type ControlGenesisAttestationRequest = Readonly<{
  project_id: ProjectId;
  control_event_id: ControlEventId;
  signer_key_id: import("./identities.ts").PublicKeyId;
  signature_preimage: Uint8Array;
  control_genesis_core: CollaborationBootstrapPlan["control_genesis_core"];
}>;

export type BootstrapExecutionFacilities = Readonly<{
  attestation_verifier: CollaborationAttestationVerifier;
  control_transition_verifier: CollaborationControlTransitionVerifier;
  create_control_genesis_attestation: (
    request: ControlGenesisAttestationRequest
  ) => Promise<AttestationRecord>;
  create_semantic_attestations: SemanticAttestationFactory;
}>;

export type BootstrapJournal = Readonly<{
  schema_version: typeof BOOTSTRAP_JOURNAL_SCHEMA_VERSION;
  object_kind: "collaboration_bootstrap_journal";
  destination_status: BootstrapDestinationStatus;
  destination_project_id: ProjectId;
  plan_commitment: BootstrapCommitment;
  source_commitment: BootstrapCommitment | null;
  identity_map_commitment: BootstrapCommitment;
  current_stage: BootstrapConstructionStage | null;
  verified_object_ids: readonly string[];
  pending_sequence_reservations: readonly string[];
  expected_control_event_id: ControlEventId;
  expected_semantic_event_id: SemanticEventId;
  checkpoint_id: CheckpointId | null;
  state_blob_id: StateBlobId | null;
  snapshot_id: SnapshotId | null;
  final_verification_outcome: "not_run" | "verified" | "failed";
  failure_reason: string | null;
}>;

export type BootstrapCompleteMarker = Readonly<{
  schema_version: typeof BOOTSTRAP_COMPLETE_MARKER_SCHEMA_VERSION;
  object_kind: "collaboration_bootstrap_complete_marker";
  destination_status: "complete_local_foundation";
  destination_project_id: ProjectId;
  plan_commitment: BootstrapCommitment;
  source_commitment: BootstrapCommitment | null;
  identity_map_commitment: BootstrapCommitment;
  control_event_id: ControlEventId;
  semantic_event_id: SemanticEventId;
  checkpoint_id: CheckpointId;
  state_blob_id: StateBlobId;
  snapshot_id: SnapshotId;
  projection_root: import("./identities.ts").ProjectionRootId;
  destination_label: "local_collaboration_foundation_only";
  no_invitations: true;
  no_export_exchange: true;
  no_synchronization: true;
  no_production_key_custody: true;
  no_secure_multi_user_claim: true;
}>;

export type BootstrapExecutionResult =
  | Readonly<{
      status: "complete_local_foundation";
      marker: BootstrapCompleteMarker;
      journal: BootstrapJournal;
      resumed: boolean;
    }>
  | Readonly<{
      status: "source_changed";
      planned_source_commitment: BootstrapCommitment;
      current_source_commitment: BootstrapCommitment;
    }>
  | Readonly<{
      status: "destination_conflict";
      reason: string;
    }>
  | Readonly<{
      status: "incomplete" | "verification_failed";
      reason: string;
      journal: BootstrapJournal;
    }>;

export type ExecuteCollaborationBootstrapInput = Readonly<{
  plan: CollaborationBootstrapPlan;
  backend: CollaborationByteStorageBackend;
  facilities: BootstrapExecutionFacilities;
  current_source_inventory?: NormalizedDuplicationSourceInventory;
  failure_injector?: BootstrapFailureInjector;
  content_store_failure_injector?: CollaborationStoreFailureInjector;
  event_object_failure_injector?: CollaborationStoreFailureInjector;
  semantic_journal_failure_injector?: Slice4FailureInjector;
}>;

const journalDomain = "patchmark/bootstrap-journal/v1";
const markerDomain = "patchmark/bootstrap-complete-marker/v1";

export async function executeCollaborationBootstrap(
  input: ExecuteCollaborationBootstrapInput
): Promise<BootstrapExecutionResult> {
  const plan = await verifyCollaborationBootstrapPlan(input.plan);
  const sourceCheck = await verifyCurrentSource(plan, input.current_source_inventory);
  if (sourceCheck !== null) return sourceCheck;

  const journalAddress = bootstrapJournalAddress(plan.destination_project_id);
  const markerAddress = bootstrapCompleteMarkerAddress(plan.destination_project_id);
  const existingMarker = await readMarker(input.backend, markerAddress);
  if (existingMarker !== null) {
    if (existingMarker.plan_commitment !== plan.plan_commitment) {
      return Object.freeze({
        status: "destination_conflict" as const,
        reason: "A complete destination already belongs to another bootstrap plan."
      });
    }
    const existingJournal = await requireJournal(input.backend, journalAddress);
    await reopenAndVerify(plan, input.backend, input.facilities, existingMarker);
    return Object.freeze({
      status: "complete_local_foundation" as const,
      marker: existingMarker,
      journal: existingJournal,
      resumed: true
    });
  }

  let journal: BootstrapJournal;
  let resumed = false;
  const rawJournal = await input.backend.read(journalAddress);
  if (rawJournal === null) {
    journal = initialJournal(plan);
    await writeJournal(input.backend, journalAddress, journal);
  } else {
    try {
      journal = decodeJournal(rawJournal);
    } catch (error) {
      return Object.freeze({
        status: "destination_conflict" as const,
        reason: `Bootstrap journal is corrupted and cannot be taken over: ${errorMessage(error)}`
      });
    }
    if (
      journal.plan_commitment !== plan.plan_commitment ||
      journal.source_commitment !== plan.source_inventory_commitment ||
      journal.identity_map_commitment !== plan.identity_map_commitment
    ) {
      return Object.freeze({
        status: "destination_conflict" as const,
        reason: "An incomplete destination attempt belongs to a different frozen plan."
      });
    }
    if (journal.destination_status === "abandoned") {
      return Object.freeze({
        status: "destination_conflict" as const,
        reason: "The isolated destination attempt was abandoned and cannot be resumed."
      });
    }
    resumed = true;
  }

  const revisions = new ImmutableCollaborationStore({
    backend: input.backend,
    ...(input.content_store_failure_injector
      ? { failure_injector: input.content_store_failure_injector }
      : {})
  });
  const events = new EventControlStore({
    backend: input.backend,
    attestation_verifier: input.facilities.attestation_verifier,
    control_transition_verifier: input.facilities.control_transition_verifier,
    ...(input.event_object_failure_injector
      ? { object_failure_injector: input.event_object_failure_injector }
      : {}),
    ...(input.semantic_journal_failure_injector
      ? { failure_injector: input.semantic_journal_failure_injector }
      : {})
  });
  const consolidation = new ConsolidationCollaborationStore({
    backend: input.backend
  });

  try {
    journal = await enterStage(input, journalAddress, journal, "validate_frozen_plan_and_source");
    await verifyCollaborationBootstrapPlan(plan);
    journal = await enterStage(input, journalAddress, journal, "establish_isolated_destination");

    journal = await enterStage(input, journalAddress, journal, "persist_markdown_blobs");
    for (const object of plan.markdown_objects.filter((entry) => entry.object_role === "current_document")) {
      const result = await revisions.putMarkdownBlob(object.project_id, object.exact_bytes);
      if (result.id !== object.markdown_blob_id) throw new Error("Stored current Markdown ID differs from the frozen plan.");
      journal = await recordVerifiedObject(input.backend, journalAddress, journal, result.id);
    }

    journal = await enterStage(input, journalAddress, journal, "persist_baseline_revisions");
    for (const object of plan.revision_objects) {
      const result = await revisions.putRevision(object.core);
      if (result.id !== object.revision_id) throw new Error("Stored baseline revision differs from the frozen plan.");
      journal = await recordVerifiedObject(input.backend, journalAddress, journal, result.id);
    }

    journal = await enterStage(input, journalAddress, journal, "persist_imported_evidence");
    for (const object of plan.markdown_objects.filter((entry) => entry.object_role === "imported_legacy_version")) {
      const result = await revisions.putMarkdownBlob(object.project_id, object.exact_bytes);
      if (result.id !== object.markdown_blob_id) throw new Error("Stored imported evidence differs from the frozen plan.");
      journal = await recordVerifiedObject(input.backend, journalAddress, journal, result.id);
    }

    journal = await enterStage(input, journalAddress, journal, "calculate_control_state");
    if (plan.control_genesis_core.resulting_control_state_root !== plan.control_state_root) {
      throw new Error("Control genesis does not bind the planned control-state root.");
    }

    journal = await enterStage(input, journalAddress, journal, "create_control_genesis");
    await persistControlGenesis(plan, events, input.facilities);
    journal = await recordVerifiedObject(
      input.backend,
      journalAddress,
      journal,
      plan.expected_control_event_id
    );

    journal = await enterStage(input, journalAddress, journal, "persist_semantic_bootstrap_payload");
    const storedPayload = await events.putSemanticPayload(plan.semantic_payload_core);
    if (storedPayload.id !== plan.expected_semantic_payload_id) {
      throw new Error("Stored bootstrap payload differs from the frozen plan.");
    }
    journal = await recordVerifiedObject(input.backend, journalAddress, journal, storedPayload.id);

    journal = await enterStage(input, journalAddress, journal, "append_semantic_bootstrap_event");
    const beforeBootstrapAppend = await events.reconstructProject(plan.destination_project_id);
    if (!beforeBootstrapAppend.accepted_semantic_event_ids.includes(plan.expected_semantic_event_id)) {
      const appended = await events.appendLocalSemanticEvent({
        project_id: plan.destination_project_id,
        author_device_id: plan.owner_device_id,
        semantic_kind: "collaboration_bootstrap_import",
        semantic_payload_id: plan.expected_semantic_payload_id,
        causal_parent_event_ids: Object.freeze([]),
        authorizing_control_head_id: plan.expected_control_event_id,
        key_epoch_id: plan.initial_key_epoch_id,
        complete_known_frontier: true,
        create_attestations: input.facilities.create_semantic_attestations
      });
      if (appended.event.event_id !== plan.expected_semantic_event_id) {
        throw new Error("Slice 4 journal allocated a bootstrap event outside the frozen plan.");
      }
    }
    journal = await recordVerifiedObject(input.backend, journalAddress, journal, plan.expected_semantic_event_id);

    journal = await enterStage(input, journalAddress, journal, "reconstruct_accepted_events");
    const state = await events.reconstructProject(plan.destination_project_id);
    requireAcceptedFoundation(plan, state);
    journal = await updatePendingReservations(input.backend, journalAddress, journal, state);

    journal = await enterStage(input, journalAddress, journal, "project_shared_state");
    const projectorInput = bootstrapProjectorBoundary(plan, state, events, revisions);
    const replay = await projectCollaborationHistory(projectorInput);

    journal = await enterStage(input, journalAddress, journal, "verify_projection_equivalence");
    verifyBootstrapProjectionEquivalence(replay.projection, plan.expected_shared_state);

    journal = await enterStage(input, journalAddress, journal, "prepare_checkpoint");
    const prepared = await prepareConsolidationCheckpoint({
      projector_input: projectorInput,
      base_frontier_event_ids: Object.freeze([plan.expected_semantic_event_id]),
      resolution_operations: Object.freeze([]),
      authorizing_control_head_id: plan.expected_control_event_id,
      reducer_version: INITIAL_REDUCER_VERSION
    });

    journal = await enterStage(input, journalAddress, journal, "append_checkpoint");
    const checkpointPayload = await events.putSemanticPayload(prepared.payload);
    const beforeCheckpointAppend = await events.reconstructProject(plan.destination_project_id);
    let checkpointId = journal.checkpoint_id;
    if (
      checkpointId === null ||
      !beforeCheckpointAppend.accepted_semantic_event_ids.includes(checkpointId)
    ) {
      const checkpointAppend = await events.appendLocalSemanticEvent({
        project_id: plan.destination_project_id,
        author_device_id: plan.owner_device_id,
        semantic_kind: "consolidation_checkpoint",
        semantic_payload_id: checkpointPayload.id,
        causal_parent_event_ids: Object.freeze([plan.expected_semantic_event_id]),
        authorizing_control_head_id: plan.expected_control_event_id,
        key_epoch_id: plan.initial_key_epoch_id,
        complete_known_frontier: true,
        create_attestations: input.facilities.create_semantic_attestations
      });
      checkpointId = checkpointAppend.event.event_id as CheckpointId;
    }
    journal = await writeJournal(input.backend, journalAddress, freezeRecord({
      ...journal,
      checkpoint_id: checkpointId,
      verified_object_ids: sortedUnique([
        ...journal.verified_object_ids,
        checkpointPayload.id,
        checkpointId
      ])
    }));

    journal = await enterStage(input, journalAddress, journal, "verify_full_history_checkpoint");
    const checkpointState = await events.reconstructProject(plan.destination_project_id);
    const checkpointProjectorInput = projectorBoundary(
      plan,
      checkpointState,
      events,
      revisions
    );
    const verification = await verifyFullHistoryCheckpoint({
      checkpoint_event_id: checkpointId,
      projector_input: checkpointProjectorInput,
      verify_checkpoint_event: async (eventId) => checkpointState.accepted_semantic_event_ids.includes(eventId)
        ? Object.freeze({ status: "accepted" as const })
        : Object.freeze({ status: "invalid" as const, reason: "Checkpoint event is not accepted." })
    });
    const verifiedCheckpoint = requireVerifiedCheckpoint(verification);

    journal = await enterStage(input, journalAddress, journal, "persist_state_blob");
    const stateBlob = await constructStateBlob(verifiedCheckpoint);
    await consolidation.putVerifiedStateBlob(verifiedCheckpoint, stateBlob);
    journal = await writeJournal(input.backend, journalAddress, freezeRecord({
      ...journal,
      state_blob_id: stateBlob.state_blob_id,
      verified_object_ids: sortedUnique([...journal.verified_object_ids, stateBlob.state_blob_id])
    }));

    journal = await enterStage(input, journalAddress, journal, "persist_snapshot_and_boundary");
    const snapshot = await constructProjectionSnapshot(
      verifiedCheckpoint,
      stateBlob,
      checkpointProjectorInput
    );
    await consolidation.putVerifiedSnapshot(verifiedCheckpoint, stateBlob, snapshot);
    const snapshotVerification = await verifyProjectionSnapshot({
      ...checkpointProjectorInput,
      checkpoint_id: verifiedCheckpoint.checkpoint_id,
      checkpoint_payload: verifiedCheckpoint.prepared.payload,
      snapshot,
      state_blob: stateBlob
    });
    if (snapshotVerification.status !== "verified") {
      throw new BootstrapVerificationError(
        `Initial snapshot verification failed: ${snapshotVerification.reason}`
      );
    }
    journal = await writeJournal(input.backend, journalAddress, freezeRecord({
      ...journal,
      snapshot_id: snapshot.snapshot_id,
      verified_object_ids: sortedUnique([...journal.verified_object_ids, snapshot.snapshot_id])
    }));

    journal = await enterStage(input, journalAddress, journal, "reopen_and_verify");
    const marker = completeMarker(plan, verifiedCheckpoint, stateBlob, snapshot);
    await reopenAndVerify(plan, input.backend, input.facilities, marker);

    journal = await enterStage(input, journalAddress, journal, "write_complete_marker");
    journal = await writeJournal(input.backend, journalAddress, freezeRecord({
      ...journal,
      destination_status: "complete_local_foundation" as const,
      final_verification_outcome: "verified" as const,
      failure_reason: null
    }));
    await input.backend.write(
      markerAddress,
      encodeMarker(marker),
      { stage: "commit_marker" }
    );
    const reread = await readMarker(input.backend, markerAddress);
    if (reread === null || reread.plan_commitment !== plan.plan_commitment) {
      throw new BootstrapVerificationError("Bootstrap complete marker failed exact read-back verification.");
    }
    return Object.freeze({
      status: "complete_local_foundation" as const,
      marker: reread,
      journal,
      resumed
    });
  } catch (error) {
    const reason = errorMessage(error);
    const status = error instanceof BootstrapVerificationError
      ? "verification_failed" as const
      : "incomplete" as const;
    const failed = freezeRecord({
      ...journal,
      destination_status: status,
      final_verification_outcome: status === "verification_failed" ? "failed" as const : journal.final_verification_outcome,
      failure_reason: reason
    });
    try {
      journal = await writeJournal(input.backend, journalAddress, failed);
    } catch {
      journal = failed;
    }
    return Object.freeze({ status, reason, journal });
  }
}

export async function abandonIncompleteBootstrapDestination(
  backend: CollaborationByteStorageBackend,
  projectId: ProjectId,
  planCommitment: BootstrapCommitment
): Promise<BootstrapJournal> {
  const address = bootstrapJournalAddress(projectId);
  const marker = await readMarker(backend, bootstrapCompleteMarkerAddress(projectId));
  if (marker !== null) throw new Error("A complete local foundation cannot be abandoned.");
  const journal = await requireJournal(backend, address);
  if (journal.plan_commitment !== parseBootstrapCommitment(planCommitment)) {
    throw new Error("Only the exact bootstrap plan may abandon its incomplete destination.");
  }
  return writeJournal(backend, address, freezeRecord({
    ...journal,
    destination_status: "abandoned" as const,
    failure_reason: "Destination attempt explicitly abandoned; source state was never mutated."
  }));
}

export async function readBootstrapDestinationStatus(
  backend: CollaborationByteStorageBackend,
  projectId: ProjectId
): Promise<Readonly<{
  status: BootstrapDestinationStatus | "absent";
  marker: BootstrapCompleteMarker | null;
  journal: BootstrapJournal | null;
}>> {
  const project = parseEntityId("project", projectId);
  const marker = await readMarker(backend, bootstrapCompleteMarkerAddress(project));
  const raw = await backend.read(bootstrapJournalAddress(project));
  const journal = raw === null ? null : decodeJournal(raw);
  return Object.freeze({
    status: marker !== null
      ? "complete_local_foundation" as const
      : journal?.destination_status ?? "absent" as const,
    marker,
    journal
  });
}

export function verifyBootstrapProjectionEquivalence(
  projectionValue: CollaborationProjection,
  expectedValue: CollaborationBootstrapImportData
): void {
  const projection = parseCollaborationProjection(projectionValue);
  const expected = parseCollaborationBootstrapImportData(
    expectedValue,
    projection.project_id
  );
  const boundary = projection.bootstrap_import;
  if (boundary === undefined || !canonicalEqual(boundary.data, expected)) {
    throw new BootstrapVerificationError(
      "Projected bootstrap boundary does not exactly match the planned shared state."
    );
  }
  requireResolved(projection.project_title, expected.project_title, "project title");
  if (!sameStrings(projection.group_order, expected.group_order)) {
    throw new BootstrapVerificationError("Projected group order differs from the planned order.");
  }
  if (!sameStrings(projection.document_order, expected.document_order)) {
    throw new BootstrapVerificationError("Projected document order differs from the planned order.");
  }
  if (
    projection.groups.length !== expected.groups.length ||
    projection.documents.length !== expected.documents.length ||
    projection.review_batches.length !== expected.review_batches.length ||
    projection.rewrite_sessions.length !== expected.rewrite_sessions.length
  ) {
    throw new BootstrapVerificationError("Projection has missing or extra shared entities.");
  }
  for (const expectedGroup of expected.groups) {
    const actual = projection.groups.find((entry) => entry.group_id === expectedGroup.group_id);
    if (!actual) throw new BootstrapVerificationError("Projected group is missing.");
    requireResolved(actual.title, expectedGroup.title, "group title");
    requireResolved(actual.position, expectedGroup.position, "group position");
  }
  for (const expectedDocument of expected.documents) {
    const actual = projection.documents.find(
      (entry) => entry.document_id === expectedDocument.document_id
    );
    if (!actual) throw new BootstrapVerificationError("Projected document is missing.");
    requireResolved(actual.title, expectedDocument.title, "document title");
    requireResolved(actual.logical_path, expectedDocument.logical_path, "document path");
    requireResolved(actual.position, expectedDocument.position, "document position");
    requireResolved(actual.archive_status, expectedDocument.archive_status, "document archive status");
    if (expectedDocument.group_id === null) requireUnset(actual.group, "document group");
    else requireResolved(actual.group, expectedDocument.group_id, "document group");
    if ((actual.tombstone !== null) !== expectedDocument.tombstone) {
      throw new BootstrapVerificationError("Document tombstone differs from the planned current state.");
    }
    if (
      actual.comments.length !== expectedDocument.comments.length ||
      actual.patches.length !== expectedDocument.patches.length
    ) {
      throw new BootstrapVerificationError("Document has missing or extra imported entities.");
    }
    for (const expectedComment of expectedDocument.comments) {
      const comment = actual.comments.find((entry) => entry.comment_id === expectedComment.comment_id);
      if (!comment) throw new BootstrapVerificationError("Projected comment is missing.");
      requireResolved(comment.body, expectedComment.body, "comment body");
      requireResolved(comment.anchor, expectedComment.anchor, "comment anchor");
      requireResolved(comment.status, expectedComment.status, "comment status");
      if (comment.trash_status === undefined) {
        throw new BootstrapVerificationError("Projected comment trash status is missing.");
      }
      requireResolved(
        comment.trash_status,
        expectedComment.trash_status,
        "comment trash status"
      );
      if ((comment.tombstone !== null) !== expectedComment.tombstone) {
        throw new BootstrapVerificationError("Comment tombstone differs from the plan.");
      }
      if (comment.replies.length !== expectedComment.replies.length) {
        throw new BootstrapVerificationError("Comment has missing or extra replies.");
      }
      for (const expectedReply of expectedComment.replies) {
        const reply = comment.replies.find((entry) => entry.reply_id === expectedReply.reply_id);
        if (!reply) throw new BootstrapVerificationError("Projected reply is missing.");
        requireResolved(reply.body, expectedReply.body, "reply body");
        if ((reply.tombstone !== null) !== expectedReply.tombstone) {
          throw new BootstrapVerificationError("Reply tombstone differs from the plan.");
        }
      }
    }
    for (const expectedPatch of expectedDocument.patches) {
      const patch = actual.patches.find((entry) => entry.patch_id === expectedPatch.patch_id);
      if (!patch || patch.versions.length !== expectedPatch.versions.length) {
        throw new BootstrapVerificationError("Projected patch or version is missing.");
      }
      for (const expectedVersion of expectedPatch.versions) {
        const version = patch.versions.find(
          (entry) => entry.patch_version_id === expectedVersion.patch_version_id
        );
        if (
          !version ||
          version.revision_id !== expectedVersion.revision_id ||
          version.target_provenance !== expectedVersion.target_provenance ||
          !sameStrings(
            version.dependency_patch_version_ids,
            expectedVersion.dependency_patch_version_ids
          )
        ) {
          throw new BootstrapVerificationError("Projected patch version differs from the plan.");
        }
        if (expectedVersion.decision === "pending") requireUnset(version.decision, "patch decision");
        else requireResolved(version.decision, expectedVersion.decision, "patch decision");
      }
    }
    if (!sameStrings(
      actual.references.map((entry) => entry.target_document_id),
      expectedDocument.reference_document_ids
    )) {
      throw new BootstrapVerificationError("Projected document references differ from the plan.");
    }
    const heads = projection.revision_heads.find(
      (entry) => entry.document_id === expectedDocument.document_id
    );
    if (!heads?.head_revision_ids.includes(expectedDocument.baseline_revision_id)) {
      throw new BootstrapVerificationError("Planned baseline revision is not an adopted head.");
    }
  }
  for (const expectedReview of expected.review_batches) {
    const review = projection.review_batches.find(
      (entry) => entry.review_batch_id === expectedReview.review_batch_id
    );
    if (!review) throw new BootstrapVerificationError("Projected review batch is missing.");
    requireResolved(review.lifecycle, expectedReview.lifecycle, "review lifecycle");
    if (expectedReview.response_evidence_commitment === null) {
      requireUnset(
        review.response_evidence_commitment,
        "review response evidence commitment"
      );
      requireUnset(review.response_import_id, "review response import id");
    } else {
      requireResolved(
        review.response_evidence_commitment,
        expectedReview.response_evidence_commitment,
        "review response evidence commitment"
      );
      requireResolved(
        review.response_import_id,
        expectedReview.response_import_id!,
        "review response import id"
      );
    }
    if (!sameStrings(
      review.contribution_payload_ids,
      expectedReview.contribution_payload_ids
    )) {
      throw new BootstrapVerificationError(
        "Projected review contributions differ from the plan."
      );
    }
  }
  for (const expectedRewrite of expected.rewrite_sessions) {
    const rewrite = projection.rewrite_sessions.find(
      (entry) => entry.rewrite_session_id === expectedRewrite.rewrite_session_id
    );
    if (!rewrite || rewrite.document_id !== expectedRewrite.document_id) {
      throw new BootstrapVerificationError("Projected rewrite session is missing or misowned.");
    }
    const outcome = expectedRewrite.outcome === "applied"
      ? `applied:${expectedRewrite.applied_revision_ids.join(",")}`
      : expectedRewrite.outcome;
    requireResolved(rewrite.outcome, outcome, "rewrite outcome");
    if (!sameStrings(rewrite.applied_revision_ids, expectedRewrite.applied_revision_ids)) {
      throw new BootstrapVerificationError("Projected rewrite revisions differ from the plan.");
    }
  }
  if (projection.conflicts.length > 0 || projection.reduction_rejections.length > 0) {
    throw new BootstrapVerificationError("Bootstrap projection contains unexpected conflicts or reducer rejections.");
  }
}

async function persistControlGenesis(
  plan: CollaborationBootstrapPlan,
  events: EventControlStore,
  facilities: BootstrapExecutionFacilities
): Promise<void> {
  const identity = await deriveControlEventCoreIdentity(plan.control_genesis_core);
  if (identity.id !== plan.expected_control_event_id) {
    throw new Error("Control genesis identity differs from the frozen plan.");
  }
  const attestation = parseAttestationRecord(
    await facilities.create_control_genesis_attestation({
      project_id: plan.destination_project_id,
      control_event_id: identity.id,
      signer_key_id: plan.control_genesis_core.offline_root_key_id,
      signature_preimage: encodeCanonicalCbor(
        buildSignaturePreimage(
          "control_event",
          plan.destination_project_id,
          identity.id
        )
      ),
      control_genesis_core: plan.control_genesis_core
    })
  );
  if (
    attestation.core.project_id !== plan.destination_project_id ||
    attestation.core.subject_kind !== "control_event" ||
    attestation.core.subject_id !== identity.id ||
    attestation.core.signer_key_id !== plan.control_genesis_core.offline_root_key_id
  ) {
    throw new Error("Injected control genesis attestation is not exactly bound to the plan.");
  }
  await events.putAttestationRecord(attestation);
  const record: ControlEventRecord = parseControlEventRecordStructure({
    record_version: 1,
    object_kind: "control_event",
    control_event_id: identity.id,
    core: plan.control_genesis_core,
    authority_attestation_id: attestation.attestation_id
  });
  const ingested = await events.ingestControlEvent(record);
  if (!ingested.state.accepted_control_event_ids.includes(identity.id)) {
    throw new BootstrapVerificationError("Control genesis did not verify as accepted.");
  }
}

function projectorBoundary(
  plan: CollaborationBootstrapPlan,
  state: EventControlProjectState,
  events: EventControlStore,
  revisions: ImmutableCollaborationStore
): CollaborationProjectorInput {
  return Object.freeze({
    project_id: plan.destination_project_id,
    accepted_semantic_event_ids: state.accepted_semantic_event_ids,
    accepted_semantic_frontier: state.accepted_semantic_frontier,
    accepted_control_facts: Object.freeze([{
      control_event_id: plan.expected_control_event_id,
      merge_policy: plan.initial_merge_policy,
      device_authorities: plan.control_state.device_authorities
    }]),
    onboarding_boundaries: Object.freeze([]),
    read_event: (id) => events.immutableObjects.getSemanticEvent(id),
    read_payload: (id) => events.immutableObjects.getSemanticPayload(id),
    read_revision: (id) => revisions.getRevision(id),
    read_blob: (projectId, id) => revisions.getMarkdownBlob(projectId, id),
    read_attestation: (id) => events.immutableObjects.getAttestation(id)
  });
}

function bootstrapProjectorBoundary(
  plan: CollaborationBootstrapPlan,
  state: EventControlProjectState,
  events: EventControlStore,
  revisions: ImmutableCollaborationStore
): CollaborationProjectorInput {
  return Object.freeze({
    ...projectorBoundary(plan, state, events, revisions),
    accepted_semantic_event_ids: Object.freeze([plan.expected_semantic_event_id]),
    accepted_semantic_frontier: Object.freeze([plan.expected_semantic_event_id])
  });
}

async function reopenAndVerify(
  plan: CollaborationBootstrapPlan,
  backend: CollaborationByteStorageBackend,
  facilities: BootstrapExecutionFacilities,
  marker: BootstrapCompleteMarker
): Promise<void> {
  const events = new EventControlStore({
    backend,
    attestation_verifier: facilities.attestation_verifier,
    control_transition_verifier: facilities.control_transition_verifier
  });
  const revisions = new ImmutableCollaborationStore({ backend });
  const consolidation = new ConsolidationCollaborationStore({ backend });
  const revisionRecovery = await revisions.recover();
  if (
    revisionRecovery.corrupted_object_ids.length > 0 ||
    revisionRecovery.mismatched_object_ids.length > 0
  ) {
    throw new BootstrapVerificationError("Reopen found corrupted or mismatched immutable content.");
  }
  const state = await events.reopenProject(plan.destination_project_id);
  requireAcceptedFoundation(plan, state);
  if (!state.accepted_semantic_event_ids.includes(marker.checkpoint_id)) {
    throw new BootstrapVerificationError("Reopened checkpoint is not accepted.");
  }
  const projectorInput = projectorBoundary(plan, state, events, revisions);
  const verification = requireVerifiedCheckpoint(await verifyFullHistoryCheckpoint({
    checkpoint_event_id: marker.checkpoint_id,
    projector_input: projectorInput,
    verify_checkpoint_event: async (eventId) => state.accepted_semantic_event_ids.includes(eventId)
      ? Object.freeze({ status: "accepted" as const })
      : Object.freeze({ status: "invalid" as const, reason: "Reopened checkpoint is not accepted." })
  }));
  verifyBootstrapProjectionEquivalence(
    verification.prepared.result_projection,
    plan.expected_shared_state
  );
  await consolidation.recover();
  const stateBlobRead = await consolidation.getStateBlob(marker.state_blob_id);
  const snapshotRead = await consolidation.getSnapshot(marker.snapshot_id);
  if (stateBlobRead.status !== "valid" || snapshotRead.status !== "valid") {
    throw new BootstrapVerificationError("Reopen could not read the exact state blob and snapshot.");
  }
  const stateBlob = parseCanonicalStateBlobRecord(stateBlobRead.value);
  const snapshot = snapshotRead.value;
  const verified = await verifyProjectionSnapshot({
    ...projectorInput,
    checkpoint_id: verification.checkpoint_id,
    checkpoint_payload: verification.prepared.payload,
    snapshot,
    state_blob: stateBlob
  });
  if (
    verified.status !== "verified" ||
    stateBlob.core.projection_root !== marker.projection_root ||
    snapshot.snapshot_id !== marker.snapshot_id
  ) {
    throw new BootstrapVerificationError("Reopen did not reproduce the complete marker roots.");
  }
  for (const object of plan.markdown_objects) {
    const read = await revisions.getMarkdownBlob(object.project_id, object.markdown_blob_id);
    if (read.status !== "valid" || !sameBytes(read.value.bytes, object.exact_bytes)) {
      throw new BootstrapVerificationError("Reopened Markdown bytes differ from the frozen plan.");
    }
  }
  for (const object of plan.revision_objects) {
    const read = await revisions.getRevision(object.revision_id);
    if (read.status !== "valid" || read.value.core.document_id !== object.document_id) {
      throw new BootstrapVerificationError("Reopened baseline revision differs from the frozen plan.");
    }
  }
}

function completeMarker(
  plan: CollaborationBootstrapPlan,
  verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>,
  stateBlob: CanonicalStateBlobRecord,
  snapshot: ProjectionSnapshotRecord
): BootstrapCompleteMarker {
  return freezeRecord({
    schema_version: BOOTSTRAP_COMPLETE_MARKER_SCHEMA_VERSION,
    object_kind: "collaboration_bootstrap_complete_marker" as const,
    destination_status: "complete_local_foundation" as const,
    destination_project_id: plan.destination_project_id,
    plan_commitment: plan.plan_commitment,
    source_commitment: plan.source_inventory_commitment,
    identity_map_commitment: plan.identity_map_commitment,
    control_event_id: plan.expected_control_event_id,
    semantic_event_id: plan.expected_semantic_event_id,
    checkpoint_id: verification.checkpoint_id,
    state_blob_id: stateBlob.state_blob_id,
    snapshot_id: snapshot.snapshot_id,
    projection_root: stateBlob.core.projection_root,
    destination_label: "local_collaboration_foundation_only" as const,
    no_invitations: true as const,
    no_export_exchange: true as const,
    no_synchronization: true as const,
    no_production_key_custody: true as const,
    no_secure_multi_user_claim: true as const
  });
}

function initialJournal(plan: CollaborationBootstrapPlan): BootstrapJournal {
  return freezeRecord({
    schema_version: BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    object_kind: "collaboration_bootstrap_journal" as const,
    destination_status: "planned" as const,
    destination_project_id: plan.destination_project_id,
    plan_commitment: plan.plan_commitment,
    source_commitment: plan.source_inventory_commitment,
    identity_map_commitment: plan.identity_map_commitment,
    current_stage: null,
    verified_object_ids: Object.freeze([]),
    pending_sequence_reservations: Object.freeze([]),
    expected_control_event_id: plan.expected_control_event_id,
    expected_semantic_event_id: plan.expected_semantic_event_id,
    checkpoint_id: null,
    state_blob_id: null,
    snapshot_id: null,
    final_verification_outcome: "not_run" as const,
    failure_reason: null
  });
}

async function enterStage(
  input: ExecuteCollaborationBootstrapInput,
  address: CollaborationStorageAddress,
  journal: BootstrapJournal,
  stage: BootstrapConstructionStage
): Promise<BootstrapJournal> {
  const next = await writeJournal(input.backend, address, freezeRecord({
    ...journal,
    destination_status: "staging" as const,
    current_stage: stage,
    failure_reason: null
  }));
  await input.failure_injector?.(stage);
  return next;
}

async function recordVerifiedObject(
  backend: CollaborationByteStorageBackend,
  address: CollaborationStorageAddress,
  journal: BootstrapJournal,
  objectId: string
): Promise<BootstrapJournal> {
  return writeJournal(backend, address, freezeRecord({
    ...journal,
    verified_object_ids: sortedUnique([...journal.verified_object_ids, objectId])
  }));
}

async function updatePendingReservations(
  backend: CollaborationByteStorageBackend,
  address: CollaborationStorageAddress,
  journal: BootstrapJournal,
  state: EventControlProjectState
): Promise<BootstrapJournal> {
  return writeJournal(backend, address, freezeRecord({
    ...journal,
    pending_sequence_reservations: Object.freeze(
      state.pending_reservations.map((entry) => entry.resulting_event_id).sort()
    )
  }));
}

async function verifyCurrentSource(
  plan: CollaborationBootstrapPlan,
  current: NormalizedDuplicationSourceInventory | undefined
): Promise<Extract<BootstrapExecutionResult, { status: "source_changed" }> | null> {
  if (plan.bootstrap_kind === "native") {
    if (current !== undefined) throw new Error("Native bootstrap execution cannot consume a duplication source.");
    return null;
  }
  if (current === undefined || plan.source_inventory_commitment === null) {
    throw new Error("Duplicate execution requires the exact current normalized source inventory.");
  }
  const parsed = parseNormalizedDuplicationSourceInventory(current);
  const commitment = await deriveSourceInventoryCommitment(parsed);
  return commitment === plan.source_inventory_commitment
    ? null
    : Object.freeze({
        status: "source_changed" as const,
        planned_source_commitment: plan.source_inventory_commitment,
        current_source_commitment: commitment
      });
}

function requireAcceptedFoundation(
  plan: CollaborationBootstrapPlan,
  state: EventControlProjectState
): void {
  if (
    !state.accepted_control_event_ids.includes(plan.expected_control_event_id) ||
    !state.accepted_semantic_event_ids.includes(plan.expected_semantic_event_id)
  ) {
    throw new BootstrapVerificationError("Control or semantic bootstrap genesis is not accepted.");
  }
}

function requireVerifiedCheckpoint(
  value: FullHistoryCheckpointVerificationResult
): Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }> {
  if (value.status !== "full_history_verified") {
    throw new BootstrapVerificationError(
      `Initial checkpoint failed full-history verification: ${value.reason}`
    );
  }
  return value;
}

function requireResolved(register: ProjectedValueRegister, expected: string, label: string): void {
  if (
    register.state !== "resolved" ||
    register.resolved_value !== expected ||
    register.contenders.length !== 1 ||
    register.contenders[0].value !== expected
  ) {
    throw new BootstrapVerificationError(`Projected ${label} is not the exact planned value.`);
  }
}

function requireUnset(register: ProjectedValueRegister, label: string): void {
  if (
    register.state !== "unset" ||
    register.resolved_value !== null ||
    register.contenders.length !== 0
  ) {
    throw new BootstrapVerificationError(`Projected ${label} was expected to be unset.`);
  }
}

function bootstrapRoot(projectId: ProjectId): string {
  return `patchmark/collaboration/bootstrap/v1/${projectId.slice(projectId.lastIndexOf(":") + 1)}`;
}

export function bootstrapJournalAddress(projectId: ProjectId): CollaborationStorageAddress {
  return `${bootstrapRoot(parseEntityId("project", projectId))}/journal` as CollaborationStorageAddress;
}

export function bootstrapCompleteMarkerAddress(projectId: ProjectId): CollaborationStorageAddress {
  return `${bootstrapRoot(parseEntityId("project", projectId))}/complete` as CollaborationStorageAddress;
}

export function bootstrapDestinationPrefix(projectId: ProjectId): CollaborationStoragePrefix {
  return `${bootstrapRoot(parseEntityId("project", projectId))}/` as CollaborationStoragePrefix;
}

function encodeJournal(value: BootstrapJournal): Uint8Array {
  return encodeEnvelope(journalDomain, parseBootstrapJournal(value));
}

function decodeJournal(bytes: Uint8Array): BootstrapJournal {
  return parseBootstrapJournal(decodeEnvelope(journalDomain, bytes));
}

function encodeMarker(value: BootstrapCompleteMarker): Uint8Array {
  return encodeEnvelope(markerDomain, parseBootstrapCompleteMarker(value));
}

function decodeMarker(bytes: Uint8Array): BootstrapCompleteMarker {
  return parseBootstrapCompleteMarker(decodeEnvelope(markerDomain, bytes));
}

function encodeEnvelope(domain: string, value: unknown): Uint8Array {
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(domain),
    canonicalProtocolValue(value)
  ]));
}

function decodeEnvelope(domain: string, bytes: Uint8Array): unknown {
  const decoded = inspectCanonicalValue(decodeCanonicalCbor(Uint8Array.from(bytes)));
  if (decoded.kind !== "array" || decoded.values.length !== 2) {
    throw new Error("Bootstrap local record must be one canonical envelope.");
  }
  const actualDomain = inspectCanonicalValue(decoded.values[0]);
  if (actualDomain.kind !== "text" || actualDomain.value !== domain) {
    throw new Error("Bootstrap local record uses the wrong domain.");
  }
  return protocolValueFromCanonical(decoded.values[1]);
}

function parseBootstrapJournal(value: unknown): BootstrapJournal {
  const record = expectExactRecord(value, "bootstrap journal", [
    "schema_version",
    "object_kind",
    "destination_status",
    "destination_project_id",
    "plan_commitment",
    "source_commitment",
    "identity_map_commitment",
    "current_stage",
    "verified_object_ids",
    "pending_sequence_reservations",
    "expected_control_event_id",
    "expected_semantic_event_id",
    "checkpoint_id",
    "state_blob_id",
    "snapshot_id",
    "final_verification_outcome",
    "failure_reason"
  ]);
  const status = expectEnum(record.destination_status, bootstrapDestinationStatuses, "bootstrap destination status");
  const stage = record.current_stage === null
    ? null
    : expectEnum(record.current_stage, bootstrapConstructionStages, "bootstrap construction stage");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, BOOTSTRAP_JOURNAL_SCHEMA_VERSION, "bootstrap journal version"),
    object_kind: expectLiteral(record.object_kind, "collaboration_bootstrap_journal", "bootstrap journal kind"),
    destination_status: status,
    destination_project_id: parseEntityId("project", record.destination_project_id),
    plan_commitment: parseBootstrapCommitment(record.plan_commitment, "journal plan commitment"),
    source_commitment: record.source_commitment === null ? null : parseBootstrapCommitment(record.source_commitment, "journal source commitment"),
    identity_map_commitment: parseBootstrapCommitment(record.identity_map_commitment, "journal identity-map commitment"),
    current_stage: stage,
    verified_object_ids: parseSortedStringList(record.verified_object_ids, "journal verified objects"),
    pending_sequence_reservations: parseSortedStringList(record.pending_sequence_reservations, "journal sequence reservations"),
    expected_control_event_id: parseDigestId("control-event", record.expected_control_event_id),
    expected_semantic_event_id: parseDigestId("semantic-event", record.expected_semantic_event_id),
    checkpoint_id: record.checkpoint_id === null ? null : parseDigestId("semantic-event", record.checkpoint_id) as CheckpointId,
    state_blob_id: record.state_blob_id === null ? null : parseDigestId("state-blob", record.state_blob_id),
    snapshot_id: record.snapshot_id === null ? null : parseDigestId("snapshot", record.snapshot_id),
    final_verification_outcome: expectEnum(record.final_verification_outcome, ["not_run", "verified", "failed"] as const, "journal verification outcome"),
    failure_reason: record.failure_reason === null ? null : expectString(record.failure_reason, "journal failure reason")
  });
}

function parseBootstrapCompleteMarker(value: unknown): BootstrapCompleteMarker {
  const record = expectExactRecord(value, "bootstrap complete marker", [
    "schema_version",
    "object_kind",
    "destination_status",
    "destination_project_id",
    "plan_commitment",
    "source_commitment",
    "identity_map_commitment",
    "control_event_id",
    "semantic_event_id",
    "checkpoint_id",
    "state_blob_id",
    "snapshot_id",
    "projection_root",
    "destination_label",
    "no_invitations",
    "no_export_exchange",
    "no_synchronization",
    "no_production_key_custody",
    "no_secure_multi_user_claim"
  ]);
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, BOOTSTRAP_COMPLETE_MARKER_SCHEMA_VERSION, "complete marker version"),
    object_kind: expectLiteral(record.object_kind, "collaboration_bootstrap_complete_marker", "complete marker kind"),
    destination_status: expectLiteral(record.destination_status, "complete_local_foundation", "complete marker status"),
    destination_project_id: parseEntityId("project", record.destination_project_id),
    plan_commitment: parseBootstrapCommitment(record.plan_commitment, "marker plan commitment"),
    source_commitment: record.source_commitment === null ? null : parseBootstrapCommitment(record.source_commitment, "marker source commitment"),
    identity_map_commitment: parseBootstrapCommitment(record.identity_map_commitment, "marker identity-map commitment"),
    control_event_id: parseDigestId("control-event", record.control_event_id),
    semantic_event_id: parseDigestId("semantic-event", record.semantic_event_id),
    checkpoint_id: parseDigestId("semantic-event", record.checkpoint_id) as CheckpointId,
    state_blob_id: parseDigestId("state-blob", record.state_blob_id),
    snapshot_id: parseDigestId("snapshot", record.snapshot_id),
    projection_root: parseDigestId("projection-root", record.projection_root),
    destination_label: expectLiteral(record.destination_label, "local_collaboration_foundation_only", "complete marker label"),
    no_invitations: expectLiteral(record.no_invitations, true, "complete marker invitation exclusion"),
    no_export_exchange: expectLiteral(record.no_export_exchange, true, "complete marker exchange exclusion"),
    no_synchronization: expectLiteral(record.no_synchronization, true, "complete marker synchronization exclusion"),
    no_production_key_custody: expectLiteral(record.no_production_key_custody, true, "complete marker key-custody exclusion"),
    no_secure_multi_user_claim: expectLiteral(record.no_secure_multi_user_claim, true, "complete marker security-claim exclusion")
  });
}

async function writeJournal(
  backend: CollaborationByteStorageBackend,
  address: CollaborationStorageAddress,
  journal: BootstrapJournal
): Promise<BootstrapJournal> {
  const parsed = parseBootstrapJournal(journal);
  await backend.write(address, encodeJournal(parsed), { stage: "derived_index" });
  const raw = await backend.read(address);
  if (raw === null) throw new Error("Bootstrap journal write was not durable.");
  const reread = decodeJournal(raw);
  if (!canonicalEqual(parsed, reread)) throw new Error("Bootstrap journal read-back mismatch.");
  return reread;
}

async function requireJournal(
  backend: CollaborationByteStorageBackend,
  address: CollaborationStorageAddress
): Promise<BootstrapJournal> {
  const raw = await backend.read(address);
  if (raw === null) throw new Error("Complete destination is missing its bootstrap journal.");
  return decodeJournal(raw);
}

async function readMarker(
  backend: CollaborationByteStorageBackend,
  address: CollaborationStorageAddress
): Promise<BootstrapCompleteMarker | null> {
  const raw = await backend.read(address);
  return raw === null ? null : decodeMarker(raw);
}

function parseSortedStringList(value: unknown, label: string): readonly string[] {
  const entries = expectArray(value, label).map((entry) => expectString(entry, label));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1] >= entries[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  }
  return Object.freeze(entries);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const leftBytes = encodeCanonicalCbor(canonicalProtocolValue(left));
  const rightBytes = encodeCanonicalCbor(canonicalProtocolValue(right));
  return sameBytes(leftBytes, rightBytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class BootstrapVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapVerificationError";
  }
}

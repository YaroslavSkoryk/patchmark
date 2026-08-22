import { bytesToHex } from "./bytes.ts";
import {
  parseDerivedConflictRecord,
  type DerivedConflictRecord,
  type DerivedReducerConflict,
  type ReducerConflictKind
} from "./derived.ts";
import type {
  AttestationId,
  CommentId,
  DocumentId,
  DocumentRevisionId,
  GroupId,
  PatchId,
  PatchVersionId,
  ReplyId,
  ReviewBatchId,
  RewriteSessionId,
  SemanticEventId,
  SemanticPayloadId
} from "./identities.ts";
import {
  compareSemanticEventCausality,
  eventObservesAll,
  loadProjectionHistory,
  type CausalAncestryIndex,
  type LoadedProjectionEvent,
  type LoadedProjectionHistory
} from "./projection-causality.ts";
import {
  isRevisionAncestor,
  loadVerifiedRevisionGraph
} from "./projection-revisions.ts";
import type {
  CollaborationProjection,
  CollaborationProjectorInput,
  ProjectedComment,
  ProjectedDocument,
  ProjectedDocumentReference,
  ProjectedDocumentRevisionHeads,
  ProjectedGroup,
  ProjectedPatch,
  ProjectedPatchVersion,
  ProjectedReply,
  ProjectedReviewBatch,
  ProjectedRevisionAdoption,
  ProjectedRewriteSession,
  ProjectedTombstone,
  ProjectedValueRegister,
  ProjectionReductionRejection,
  ProjectionReplayResult
} from "./projection-types.ts";
import { CollaborationProjectionError } from "./projection-types.ts";
import { deriveDerivedConflictIdentity } from "./preimages.ts";
import { sha256 } from "./sha256.ts";
import {
  DERIVED_CONFLICT_SCHEMA_VERSION,
  INITIAL_REDUCER_VERSION,
  PROJECTION_SCHEMA_VERSION
} from "./versions.ts";

type MutableCandidate = {
  event_id: SemanticEventId;
  payload_id: SemanticPayloadId;
  value: string;
};

type MutableRegister = {
  key: string;
  candidates: Map<SemanticEventId, MutableCandidate>;
  history: Map<SemanticEventId, MutableCandidate>;
  last_uncontested_value: string | null;
};

type MutableTombstone = {
  deletions: Map<SemanticEventId, SemanticPayloadId>;
  contender_event_ids: Set<SemanticEventId>;
};

type MutableReply = {
  reply_id: ReplyId;
  comment_id: CommentId;
  document_id: DocumentId;
  body: MutableRegister;
  tombstone: MutableTombstone | null;
  creation_event_ids: Set<SemanticEventId>;
};

type MutableComment = {
  comment_id: CommentId;
  document_id: DocumentId;
  body: MutableRegister;
  anchor: MutableRegister;
  status: MutableRegister;
  replies: Map<ReplyId, MutableReply>;
  tombstone: MutableTombstone | null;
  creation_event_ids: Set<SemanticEventId>;
};

type MutablePatchVersion = {
  patch_version_id: PatchVersionId;
  revision_id: DocumentRevisionId | null;
  dependency_patch_version_ids: readonly PatchVersionId[];
  target_provenance: string | null;
  proposal_event_ids: Set<SemanticEventId>;
  proposal_payload_ids: Set<SemanticPayloadId>;
  decision: MutableRegister;
};

type MutablePatch = {
  patch_id: PatchId;
  document_id: DocumentId;
  versions: Map<PatchVersionId, MutablePatchVersion>;
};

type MutableDocument = {
  document_id: DocumentId;
  title: MutableRegister;
  logical_path: MutableRegister;
  position: MutableRegister;
  group: MutableRegister;
  archive_status: MutableRegister;
  tombstone: MutableTombstone | null;
  creation_event_ids: Set<SemanticEventId>;
  comments: Map<CommentId, MutableComment>;
  patches: Map<PatchId, MutablePatch>;
  references: Map<DocumentId, Set<SemanticEventId>>;
};

type MutableGroup = {
  group_id: GroupId;
  title: MutableRegister;
  position: MutableRegister;
  creation_event_ids: Set<SemanticEventId>;
};

type MutableReviewBatch = {
  review_batch_id: ReviewBatchId;
  lifecycle: MutableRegister;
  responses: MutableRegister;
  contribution_payload_ids: Set<SemanticPayloadId>;
  creation_event_ids: Set<SemanticEventId>;
};

type MutableRewriteSession = {
  rewrite_session_id: RewriteSessionId;
  document_id: DocumentId;
  outcome: MutableRegister;
  applied_revision_ids: Set<DocumentRevisionId>;
  creation_event_ids: Set<SemanticEventId>;
};

type AdoptionKind = ProjectedRevisionAdoption["adoption_kinds"][number];

type AdoptionIntent = {
  revision_id: DocumentRevisionId;
  document_id: DocumentId | null;
  event_id: SemanticEventId;
  payload_id: SemanticPayloadId;
  author_device_id: LoadedProjectionEvent["provenance"]["author_device_id"];
  author_role: LoadedProjectionEvent["provenance"]["author_role"];
  attestation_ids: readonly AttestationId[];
  adoption_kind: AdoptionKind;
  authorized: boolean;
};

type ProjectorState = {
  history: LoadedProjectionHistory;
  project_title: MutableRegister;
  groups: Map<GroupId, MutableGroup>;
  documents: Map<DocumentId, MutableDocument>;
  review_batches: Map<ReviewBatchId, MutableReviewBatch>;
  rewrite_sessions: Map<RewriteSessionId, MutableRewriteSession>;
  registers: Map<string, MutableRegister>;
  adoptions: AdoptionIntent[];
  rejections: ProjectionReductionRejection[];
  loaded_by_id: Map<SemanticEventId, LoadedProjectionEvent>;
  bootstrap_import: Readonly<{
    event_id: SemanticEventId;
    payload_id: SemanticPayloadId;
    data: import("./bootstrap-semantic.ts").CollaborationBootstrapImportData;
  }> | null;
};

type ConflictLocator = Readonly<{
  record: DerivedConflictRecord;
  register: MutableRegister | null;
}>;

export async function projectCollaborationHistory(
  input: CollaborationProjectorInput
): Promise<ProjectionReplayResult> {
  const history = await loadProjectionHistory(input);
  const state = createState(history);
  await predeclareSubjects(state, input);
  for (const loaded of history.events) {
    if (loaded.payload.core.semantic_kind !== "conflict_resolution") {
      reduceEvent(state, loaded);
    }
  }
  const provisional = await deriveConflicts(state);
  for (const loaded of history.events) {
    if (loaded.payload.core.semantic_kind === "conflict_resolution") {
      await reduceConflictResolution(state, loaded, provisional);
    }
  }
  const revisionHeads = await deriveRevisionHeads(state, input);
  const conflicts = await deriveConflicts(state, revisionHeads);
  const projection = await freezeProjection(state, revisionHeads, conflicts);
  return Object.freeze({
    projection,
    topological_event_ids: history.topological_event_ids
  });
}

/** Incremental caches are non-authoritative; rebuild is deliberately full replay. */
export async function rebuildCollaborationProjection(
  input: CollaborationProjectorInput,
  _previousProjection?: CollaborationProjection
): Promise<ProjectionReplayResult> {
  void _previousProjection;
  return projectCollaborationHistory(input);
}

function createState(history: LoadedProjectionHistory): ProjectorState {
  const registers = new Map<string, MutableRegister>();
  return {
    history,
    project_title: register(
      registers,
      `project|${history.events[0]?.event.core.project_id ?? ""}|title`
    ),
    groups: new Map(),
    documents: new Map(),
    review_batches: new Map(),
    rewrite_sessions: new Map(),
    registers,
    adoptions: [],
    rejections: [],
    loaded_by_id: new Map(
      history.events.map((loaded) => [loaded.event.event_id, loaded])
    ),
    bootstrap_import: null
  };
}

async function predeclareSubjects(
  state: ProjectorState,
  input: CollaborationProjectorInput
): Promise<void> {
  const genesisIntents: AdoptionIntent[] = [];
  for (const loaded of state.history.events) {
    const eventId = loaded.event.event_id;
    const payloadId = loaded.payload.payload_id;
    const core = loaded.payload.core;
    if (core.semantic_kind === "project_genesis") {
      for (const revisionId of core.data.genesis_revision_ids) {
        genesisIntents.push(adoptionIntent(loaded, revisionId, null, "genesis"));
      }
      continue;
    }
    if (core.semantic_kind === "collaboration_bootstrap_import") {
      for (const group of core.data.groups) {
        ensureGroup(state, group.group_id).creation_event_ids.add(eventId);
      }
      for (const documentData of core.data.documents) {
        const document = ensureDocument(state, documentData.document_id);
        document.creation_event_ids.add(eventId);
        genesisIntents.push(
          adoptionIntent(
            loaded,
            documentData.baseline_revision_id,
            documentData.document_id,
            "genesis"
          )
        );
        for (const commentData of documentData.comments) {
          const comment = ensureComment(
            document,
            state.registers,
            commentData.comment_id
          );
          comment.creation_event_ids.add(eventId);
          for (const replyData of commentData.replies) {
            ensureReply(comment, state.registers, replyData.reply_id)
              .creation_event_ids.add(eventId);
          }
        }
        for (const patchData of documentData.patches) {
          const patch = ensurePatch(document, patchData.patch_id);
          for (const versionData of patchData.versions) {
            ensurePatchVersion(
              patch,
              state.registers,
              versionData.patch_version_id
            );
          }
        }
      }
      for (const batchData of core.data.review_batches) {
        ensureReviewBatch(state, batchData.review_batch_id)
          .creation_event_ids.add(eventId);
      }
      for (const sessionData of core.data.rewrite_sessions) {
        ensureRewriteSession(
          state,
          sessionData.rewrite_session_id,
          sessionData.document_id
        ).creation_event_ids.add(eventId);
      }
      continue;
    }
    if (core.semantic_kind === "metadata_operation") {
      if (core.data.operation === "document_create") {
        const document = ensureDocument(state, core.data.document_id);
        document.creation_event_ids.add(eventId);
      } else if (core.data.operation === "group_create") {
        const group = ensureGroup(state, core.data.group_id);
        group.creation_event_ids.add(eventId);
      }
      continue;
    }
    if (core.semantic_kind === "comment_operation" && core.data.operation === "create") {
      const document = ensureDocument(state, core.data.document_id);
      const comment = ensureComment(document, state.registers, core.data.comment_id);
      comment.creation_event_ids.add(eventId);
      continue;
    }
    if (core.semantic_kind === "reply_operation" && core.data.operation === "create") {
      const document = ensureDocument(state, core.data.document_id);
      const comment = ensureComment(document, state.registers, core.data.comment_id);
      const reply = ensureReply(comment, state.registers, core.data.reply_id);
      reply.creation_event_ids.add(eventId);
      continue;
    }
    if (core.semantic_kind === "patch_operation" && core.data.operation === "propose") {
      const document = ensureDocument(state, core.data.document_id);
      ensurePatchVersion(
        ensurePatch(document, core.data.patch_id),
        state.registers,
        core.data.patch_version_id
      );
      continue;
    }
    if (core.semantic_kind === "review_batch_operation" && core.data.operation === "create") {
      const batch = ensureReviewBatch(state, core.data.review_batch_id);
      batch.creation_event_ids.add(eventId);
      continue;
    }
    if (core.semantic_kind === "rewrite_operation" && core.data.operation === "create") {
      const session = ensureRewriteSession(
        state,
        core.data.rewrite_session_id,
        core.data.document_id
      );
      session.creation_event_ids.add(eventId);
    }
    void payloadId;
  }
  if (genesisIntents.length > 0) {
    const graph = await loadVerifiedRevisionGraph(
      input,
      genesisIntents.map((intent) => intent.revision_id)
    );
    for (const intent of genesisIntents) {
      const revision = graph.revisions.find(
        (candidate) => candidate.record.revision_id === intent.revision_id
      );
      if (!revision) continue;
      intent.document_id = revision.record.core.document_id;
      state.adoptions.push(intent);
      const document = ensureDocument(state, revision.record.core.document_id);
      document.creation_event_ids.add(intent.event_id);
    }
  }
}

function reduceEvent(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  switch (core.semantic_kind) {
    case "project_genesis":
      return;
    case "collaboration_bootstrap_import":
      reduceBootstrapImport(state, loaded);
      return;
    case "revision_adoption":
      reduceRevisionAdoption(
        state,
        loaded,
        core.data.document_id,
        core.data.revision_id,
        "revision"
      );
      return;
    case "merge_revision_adoption":
      reduceMergeAdoption(state, loaded);
      return;
    case "external_revision_import":
      return;
    case "comment_operation":
      reduceComment(state, loaded);
      return;
    case "reply_operation":
      reduceReply(state, loaded);
      return;
    case "patch_operation":
      reducePatch(state, loaded);
      return;
    case "metadata_operation":
      reduceMetadata(state, loaded);
      return;
    case "review_batch_operation":
      reduceReviewBatch(state, loaded);
      return;
    case "rewrite_operation":
      reduceRewrite(state, loaded);
      return;
    case "consolidation_checkpoint":
      reject(state, loaded, "unsupported_payload", "Checkpoints are outside the Slice 5 projection reducer.");
      return;
    case "conflict_resolution":
      return;
  }
}

function reduceBootstrapImport(
  state: ProjectorState,
  loaded: LoadedProjectionEvent
): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "collaboration_bootstrap_import") return;
  if (state.bootstrap_import !== null) {
    reject(
      state,
      loaded,
      "duplicate_identity",
      "A project may have only one collaboration bootstrap import boundary."
    );
    return;
  }
  state.bootstrap_import = Object.freeze({
    event_id: loaded.event.event_id,
    payload_id: loaded.payload.payload_id,
    data: core.data
  });
  applyRegister(state, state.project_title, loaded, core.data.project_title);
  for (const groupData of core.data.groups) {
    const group = state.groups.get(groupData.group_id);
    if (!group) continue;
    applyRegister(state, group.title, loaded, groupData.title);
    applyRegister(state, group.position, loaded, groupData.position);
  }
  for (const documentData of core.data.documents) {
    const document = state.documents.get(documentData.document_id);
    if (!document) continue;
    applyRegister(state, document.title, loaded, documentData.title);
    applyRegister(state, document.logical_path, loaded, documentData.logical_path);
    applyRegister(state, document.position, loaded, documentData.position);
    if (documentData.group_id !== null) {
      applyRegister(state, document.group, loaded, documentData.group_id);
    }
    applyRegister(
      state,
      document.archive_status,
      loaded,
      documentData.archive_status
    );
    for (const commentData of documentData.comments) {
      const comment = document.comments.get(commentData.comment_id);
      if (!comment) continue;
      applyRegister(state, comment.body, loaded, commentData.body);
      applyRegister(state, comment.anchor, loaded, commentData.anchor);
      applyRegister(state, comment.status, loaded, commentData.status);
      for (const replyData of commentData.replies) {
        const reply = comment.replies.get(replyData.reply_id);
        if (!reply) continue;
        applyRegister(state, reply.body, loaded, replyData.body);
        if (replyData.tombstone) applyDeletion(state, reply, loaded);
      }
      if (commentData.tombstone) applyDeletion(state, comment, loaded);
    }
    for (const patchData of documentData.patches) {
      const patch = document.patches.get(patchData.patch_id);
      if (!patch) continue;
      for (const versionData of patchData.versions) {
        const version = patch.versions.get(versionData.patch_version_id);
        if (!version) continue;
        version.revision_id = versionData.revision_id;
        version.dependency_patch_version_ids =
          versionData.dependency_patch_version_ids;
        version.target_provenance = versionData.target_provenance;
        version.proposal_event_ids.add(loaded.event.event_id);
        version.proposal_payload_ids.add(loaded.payload.payload_id);
        if (versionData.decision !== "pending") {
          applyRegister(state, version.decision, loaded, versionData.decision);
          if (
            versionData.decision === "accepted" &&
            versionData.revision_id !== null
          ) {
            state.adoptions.push(
              adoptionIntent(
                loaded,
                versionData.revision_id,
                documentData.document_id,
                "patch_acceptance"
              )
            );
          }
        }
      }
    }
    for (const referenceId of documentData.reference_document_ids) {
      document.references.set(referenceId, new Set([loaded.event.event_id]));
    }
    if (documentData.tombstone) applyDeletion(state, document, loaded);
  }
  for (const batchData of core.data.review_batches) {
    const batch = state.review_batches.get(batchData.review_batch_id);
    if (!batch) continue;
    applyRegister(state, batch.lifecycle, loaded, batchData.lifecycle);
    if (batchData.response_hash !== null) {
      applyRegister(state, batch.responses, loaded, batchData.response_hash);
    }
  }
  for (const sessionData of core.data.rewrite_sessions) {
    const session = state.rewrite_sessions.get(sessionData.rewrite_session_id);
    if (!session) continue;
    applyRegister(
      state,
      session.outcome,
      loaded,
      sessionData.outcome === "applied"
        ? `applied:${sessionData.applied_revision_ids.join(",")}`
        : sessionData.outcome
    );
    for (const revisionId of sessionData.applied_revision_ids) {
      session.applied_revision_ids.add(revisionId);
      state.adoptions.push(
        adoptionIntent(
          loaded,
          revisionId,
          sessionData.document_id,
          "rewrite_apply"
        )
      );
    }
  }
}

function reduceComment(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const data = loaded.payload.core;
  if (data.semantic_kind !== "comment_operation") return;
  const document = state.documents.get(data.data.document_id);
  const comment = document?.comments.get(data.data.comment_id);
  if (!document || !comment || !observesCreation(state, loaded.event.event_id, comment.creation_event_ids)) {
    reject(state, loaded, "missing_subject", "Comment operation does not observe comment creation.");
    return;
  }
  if (!observesCreation(state, loaded.event.event_id, document.creation_event_ids)) {
    reject(state, loaded, "missing_subject", "Comment creation does not observe its document creation.");
    return;
  }
  const operation = data.data.operation;
  if (operation === "create") {
    applyRegister(state, comment.body, loaded, data.data.content);
    applyRegister(
      state,
      comment.anchor,
      loaded,
      data.data.anchor === undefined
        ? "document:document"
        : `${data.data.anchor.anchor_kind}:${data.data.anchor.anchor_key}`
    );
    applyRegister(state, comment.status, loaded, "open");
    return;
  }
  if (operation === "delete") {
    applyDeletion(state, comment, loaded);
    return;
  }
  if (blockedByDeletion(state, comment.tombstone, loaded)) return;
  if (operation === "edit") {
    applyRegister(state, comment.body, loaded, data.data.content);
  } else if (operation === "reanchor") {
    applyRegister(
      state,
      comment.anchor,
      loaded,
      `${data.data.anchor.anchor_kind}:${data.data.anchor.anchor_key}`
    );
  } else {
    applyRegister(
      state,
      comment.status,
      loaded,
      operation === "resolve" ? "resolved" : "open"
    );
  }
}

function reduceReply(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "reply_operation") return;
  const document = state.documents.get(core.data.document_id);
  const comment = document?.comments.get(core.data.comment_id);
  const reply = comment?.replies.get(core.data.reply_id);
  if (
    !document ||
    !comment ||
    !reply ||
    !observesCreation(state, loaded.event.event_id, reply.creation_event_ids)
  ) {
    reject(state, loaded, "missing_subject", "Reply operation does not observe reply creation.");
    return;
  }
  if (core.data.operation === "delete") {
    applyDeletion(state, reply, loaded);
    return;
  }
  if (blockedByDeletion(state, reply.tombstone, loaded)) return;
  applyRegister(state, reply.body, loaded, core.data.content);
}

function reduceMetadata(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "metadata_operation") return;
  const operation = core.data.operation;
  if (operation === "project_title") {
    applyRegister(state, state.project_title, loaded, core.data.value);
    return;
  }
  if (operation === "group_create") {
    const group = ensureGroup(state, core.data.group_id);
    applyRegister(state, group.title, loaded, core.data.value);
    return;
  }
  if (operation === "group_rename" || operation === "group_position") {
    const group = state.groups.get(core.data.group_id);
    if (!group || !observesCreation(state, loaded.event.event_id, group.creation_event_ids)) {
      reject(state, loaded, "missing_subject", "Group operation does not observe group creation.");
      return;
    }
    applyRegister(
      state,
      operation === "group_rename" ? group.title : group.position,
      loaded,
      core.data.value
    );
    return;
  }
  const document = state.documents.get(core.data.document_id);
  if (!document || !observesCreation(state, loaded.event.event_id, document.creation_event_ids)) {
    reject(state, loaded, "missing_subject", "Document operation does not observe document creation.");
    return;
  }
  if (operation === "document_create") {
    applyRegister(state, document.archive_status, loaded, "active");
    return;
  }
  if (operation === "document_delete") {
    applyDeletion(state, document, loaded);
    return;
  }
  if (blockedByDeletion(state, document.tombstone, loaded)) return;
  if (operation === "document_archive" || operation === "document_restore") {
    applyRegister(
      state,
      document.archive_status,
      loaded,
      operation === "document_archive" ? "archived" : "active"
    );
  } else if (operation === "document_title") {
    applyRegister(state, document.title, loaded, core.data.value);
  } else if (operation === "document_path") {
    applyRegister(state, document.logical_path, loaded, core.data.value);
  } else if (operation === "document_position") {
    applyRegister(state, document.position, loaded, core.data.value);
  } else if (operation === "document_group") {
    if (!state.groups.has(core.data.group_id)) {
      reject(state, loaded, "missing_subject", "Document group assignment names an unknown group.");
      return;
    }
    applyRegister(state, document.group, loaded, core.data.group_id);
  } else if (operation === "document_reference") {
    const events = document.references.get(core.data.target_document_id) ?? new Set();
    events.add(loaded.event.event_id);
    document.references.set(core.data.target_document_id, events);
  }
}

function reducePatch(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "patch_operation") return;
  const document = state.documents.get(core.data.document_id);
  if (!document || !observesCreation(state, loaded.event.event_id, document.creation_event_ids)) {
    reject(state, loaded, "missing_subject", "Patch operation names an unknown document.");
    return;
  }
  const patch = document.patches.get(core.data.patch_id) ??
    (core.data.operation === "propose" ? ensurePatch(document, core.data.patch_id) : null);
  if (!patch) {
    reject(state, loaded, "missing_subject", "Patch operation names an unknown logical patch.");
    return;
  }
  if (core.data.operation === "decide") {
    const version = patch.versions.get(core.data.patch_version_id);
    if (
      !version ||
      !observesCreation(state, loaded.event.event_id, version.proposal_event_ids)
    ) {
      reject(state, loaded, "missing_subject", "Patch decision does not observe the exact proposed version.");
      return;
    }
    applyRegister(state, version.decision, loaded, core.data.decision);
    if (core.data.decision === "accepted" && version.revision_id !== null) {
      state.adoptions.push(
        adoptionIntent(
          loaded,
          version.revision_id,
          core.data.document_id,
          "patch_acceptance"
        )
      );
      markDocumentDeletionContender(state, document, loaded.event.event_id);
    }
    return;
  }
  let version = patch.versions.get(core.data.patch_version_id);
  if (core.data.operation === "edit" && version) {
    const decidedBefore = [...version.decision.history.keys()].some(
      (eventId) =>
        compareSemanticEventCausality(
          state.history.ancestry,
          eventId,
          loaded.event.event_id
        ) === "causally_before"
    );
    if (decidedBefore) {
      reject(state, loaded, "invalid_transition", "A finalized patch version cannot be edited in place.");
      return;
    }
  }
  version ??= ensurePatchVersion(patch, state.registers, core.data.patch_version_id);
  version.revision_id = core.data.revision_id ?? null;
  version.dependency_patch_version_ids = core.data.dependency_patch_version_ids ?? Object.freeze([]);
  version.target_provenance = core.data.target_provenance ?? null;
  version.proposal_event_ids.add(loaded.event.event_id);
  version.proposal_payload_ids.add(loaded.payload.payload_id);
}

function reduceReviewBatch(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "review_batch_operation") return;
  const batch = state.review_batches.get(core.data.review_batch_id);
  if (!batch || !observesCreation(state, loaded.event.event_id, batch.creation_event_ids)) {
    reject(state, loaded, "missing_subject", "Review-batch operation does not observe batch creation.");
    return;
  }
  if (core.data.operation === "create") {
    applyRegister(state, batch.lifecycle, loaded, "active");
  } else if (core.data.operation === "respond") {
    applyRegister(state, batch.responses, loaded, core.data.response_hash);
    applyRegister(state, batch.lifecycle, loaded, "responded");
    for (const id of core.data.contribution_payload_ids) {
      batch.contribution_payload_ids.add(id);
    }
  } else {
    applyRegister(state, batch.lifecycle, loaded, "cancelled");
  }
}

function reduceRewrite(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "rewrite_operation") return;
  const session = state.rewrite_sessions.get(core.data.rewrite_session_id);
  const document = state.documents.get(core.data.document_id);
  if (
    !session ||
    !document ||
    !observesCreation(state, loaded.event.event_id, session.creation_event_ids) ||
    !observesCreation(state, loaded.event.event_id, document.creation_event_ids)
  ) {
    reject(state, loaded, "missing_subject", "Rewrite operation does not observe session creation.");
    return;
  }
  if (core.data.operation === "create") {
    applyRegister(state, session.outcome, loaded, "active");
  } else if (core.data.operation === "discard") {
    applyRegister(state, session.outcome, loaded, "discarded");
  } else if ("revision_id" in core.data) {
    applyRegister(state, session.outcome, loaded, `applied:${core.data.revision_id}`);
    session.applied_revision_ids.add(core.data.revision_id);
    reduceRevisionAdoption(
      state,
      loaded,
      core.data.document_id,
      core.data.revision_id,
      "rewrite_apply"
    );
  }
}

function reduceRevisionAdoption(
  state: ProjectorState,
  loaded: LoadedProjectionEvent,
  documentId: DocumentId,
  revisionId: DocumentRevisionId,
  adoptionKind: AdoptionKind
): void {
  const document = state.documents.get(documentId);
  if (!document || !observesCreation(state, loaded.event.event_id, document.creation_event_ids)) {
    reject(state, loaded, "missing_subject", "Revision adoption names an unknown document.");
    return;
  }
  const intent = adoptionIntent(loaded, revisionId, documentId, adoptionKind);
  if (!intent.authorized) {
    reject(state, loaded, "unauthorized_revision_adoption", "Only an owner or editor may adopt a document revision.");
  }
  state.adoptions.push(intent);
  markDocumentDeletionContender(state, document, loaded.event.event_id);
}

function reduceMergeAdoption(state: ProjectorState, loaded: LoadedProjectionEvent): void {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "merge_revision_adoption") return;
  const authorization = core.data.authorization;
  const role = loaded.provenance.author_role;
  const explicitValid =
    authorization.authorization_mode === "explicit_editor" &&
    authorization.authorizing_device_id === loaded.provenance.author_device_id &&
    authorization.authorizing_role === role;
  const policyValid =
    authorization.authorization_mode === "policy_authorized_proven_safe" &&
    authorization.eligible_device_id === loaded.provenance.author_device_id &&
    authorization.eligible_role === role &&
    authorization.policy_control_head_id === loaded.provenance.control_head_id;
  if (!explicitValid && !policyValid) {
    reject(state, loaded, "invalid_transition", "Merge authorization does not bind the accepted event author and control head.");
    return;
  }
  reduceRevisionAdoption(
    state,
    loaded,
    core.data.document_id,
    core.data.revision_id,
    "merge"
  );
}

async function reduceConflictResolution(
  state: ProjectorState,
  loaded: LoadedProjectionEvent,
  provisional: readonly ConflictLocator[]
): Promise<void> {
  const core = loaded.payload.core;
  if (core.semantic_kind !== "conflict_resolution") return;
  const observed = core.data.observed_contender_event_ids;
  if (observed === undefined || observed.length < 2) {
    reject(state, loaded, "unobserved_conflict", "A resolution must name the exact observed contender set.");
    return;
  }
  if (!eventObservesAll(state.history.ancestry, loaded.event.event_id, observed)) {
    reject(state, loaded, "unobserved_conflict", "A resolution cannot erase a contender it does not causally observe.");
    return;
  }
  let locator = provisional.find(
    (candidate) => candidate.record.conflict_id === core.data.conflict_id
  );
  if (!locator) locator = await deriveHistoricalRegisterConflict(state, observed, core.data.conflict_id);
  if (!locator?.register) {
    if (core.data.adopted_revision_id !== null) {
      reduceRevisionAdoption(
        state,
        loaded,
        requireRevisionResolutionDocument(state, core.data.adopted_revision_id),
        core.data.adopted_revision_id,
        "conflict_resolution"
      );
      return;
    }
    reject(state, loaded, "unobserved_conflict", "The referenced conflict is not derivable from the observed contenders.");
    return;
  }
  if (core.data.adopted_event_id === undefined || core.data.adopted_event_id === null) {
    reject(state, loaded, "invalid_transition", "A field conflict resolution must adopt one exact contender event.");
    return;
  }
  const selected = locator.register.history.get(core.data.adopted_event_id);
  if (!selected || !observed.includes(selected.event_id)) {
    reject(state, loaded, "invalid_transition", "The selected resolution value is not one of the observed contenders.");
    return;
  }
  applyRegister(state, locator.register, loaded, selected.value);
}

function applyRegister(
  state: ProjectorState,
  target: MutableRegister,
  loaded: LoadedProjectionEvent,
  value: string
): void {
  const eventId = loaded.event.event_id;
  const candidate: MutableCandidate = {
    event_id: eventId,
    payload_id: loaded.payload.payload_id,
    value
  };
  target.history.set(eventId, candidate);
  let dominated = false;
  for (const current of [...target.candidates.values()]) {
    const relation = compareSemanticEventCausality(
      state.history.ancestry,
      current.event_id,
      eventId
    );
    if (relation === "causally_before") target.candidates.delete(current.event_id);
    if (relation === "causally_after") dominated = true;
  }
  if (!dominated) target.candidates.set(eventId, candidate);
  target.last_uncontested_value = deriveLastUncontestedValue(
    state.history.ancestry,
    target
  );
}

function deriveLastUncontestedValue(
  ancestry: CausalAncestryIndex,
  target: MutableRegister
): string | null {
  const current = [...target.candidates.values()];
  const currentValues = new Set(current.map((entry) => entry.value));
  if (currentValues.size === 1) return [...currentValues][0];
  const commonPredecessors = [...target.history.values()].filter(
    (candidate) =>
      !target.candidates.has(candidate.event_id) &&
      current.every(
        (contender) =>
          compareSemanticEventCausality(
            ancestry,
            candidate.event_id,
            contender.event_id
          ) === "causally_before"
      )
  );
  const maximalCommon = commonPredecessors.filter(
    (candidate) =>
      !commonPredecessors.some(
        (other) =>
          candidate.event_id !== other.event_id &&
          compareSemanticEventCausality(
            ancestry,
            candidate.event_id,
            other.event_id
          ) === "causally_before"
      )
  );
  const values = new Set(maximalCommon.map((candidate) => candidate.value));
  return values.size === 1 ? [...values][0] : null;
}

function applyDeletion(
  state: ProjectorState,
  subject: { tombstone: MutableTombstone | null },
  loaded: LoadedProjectionEvent
): void {
  const eventId = loaded.event.event_id;
  subject.tombstone ??= {
    deletions: new Map(),
    contender_event_ids: new Set()
  };
  for (const deletionId of subject.tombstone.deletions.keys()) {
    if (
      compareSemanticEventCausality(state.history.ancestry, deletionId, eventId) ===
      "causally_before"
    ) {
      reject(state, loaded, "invalid_transition", "Permanent deletion is already in the event's causal history.");
      return;
    }
  }
  subject.tombstone.deletions.set(eventId, loaded.payload.payload_id);
  for (const contenderId of subjectCandidateEventIds(subject)) {
    if (
      compareSemanticEventCausality(
        state.history.ancestry,
        contenderId,
        eventId
      ) === "concurrent"
    ) {
      subject.tombstone.contender_event_ids.add(contenderId);
    }
  }
  if ("document_id" in subject && !(
    "comment_id" in subject || "reply_id" in subject
  )) {
    for (const intent of state.adoptions) {
      if (
        intent.document_id === subject.document_id &&
        compareSemanticEventCausality(
          state.history.ancestry,
          intent.event_id,
          eventId
        ) === "concurrent"
      ) {
        subject.tombstone.contender_event_ids.add(intent.event_id);
      }
    }
  }
}

function subjectCandidateEventIds(subject: {
  tombstone: MutableTombstone | null;
}): SemanticEventId[] {
  const registers: MutableRegister[] = [];
  if ("body" in subject && isMutableRegister(subject.body)) {
    registers.push(subject.body);
  }
  if ("anchor" in subject && isMutableRegister(subject.anchor)) {
    registers.push(subject.anchor);
  }
  if ("status" in subject && isMutableRegister(subject.status)) {
    registers.push(subject.status);
  }
  if ("title" in subject && isMutableRegister(subject.title)) {
    registers.push(subject.title);
  }
  if ("logical_path" in subject && isMutableRegister(subject.logical_path)) {
    registers.push(subject.logical_path);
  }
  if ("position" in subject && isMutableRegister(subject.position)) {
    registers.push(subject.position);
  }
  if ("group" in subject && isMutableRegister(subject.group)) {
    registers.push(subject.group);
  }
  if (
    "archive_status" in subject &&
    isMutableRegister(subject.archive_status)
  ) {
    registers.push(subject.archive_status);
  }
  return sortedUnique(
    registers.flatMap((target) => [...target.history.keys()])
  );
}

function isMutableRegister(value: unknown): value is MutableRegister {
  return typeof value === "object" && value !== null && "candidates" in value;
}

function blockedByDeletion(
  state: ProjectorState,
  tombstone: MutableTombstone | null,
  loaded: LoadedProjectionEvent
): boolean {
  if (!tombstone) return false;
  let concurrent = false;
  for (const deletionId of tombstone.deletions.keys()) {
    const relation = compareSemanticEventCausality(
      state.history.ancestry,
      deletionId,
      loaded.event.event_id
    );
    if (relation === "causally_before") {
      reject(state, loaded, "permanently_deleted", "An operation cannot resurrect a permanently deleted entity.");
      return true;
    }
    if (relation === "concurrent") concurrent = true;
  }
  if (concurrent) tombstone.contender_event_ids.add(loaded.event.event_id);
  return false;
}

function markDocumentDeletionContender(
  state: ProjectorState,
  document: MutableDocument,
  eventId: SemanticEventId
): void {
  if (!document.tombstone) return;
  for (const deletionId of document.tombstone.deletions.keys()) {
    if (
      compareSemanticEventCausality(state.history.ancestry, deletionId, eventId) ===
      "concurrent"
    ) {
      document.tombstone.contender_event_ids.add(eventId);
    }
  }
}

async function deriveRevisionHeads(
  state: ProjectorState,
  input: CollaborationProjectorInput
): Promise<readonly ProjectedDocumentRevisionHeads[]> {
  const allRevisionIds = sortedUnique(state.adoptions.map((intent) => intent.revision_id));
  if (allRevisionIds.length === 0) return Object.freeze([]);
  const graph = await loadVerifiedRevisionGraph(input, allRevisionIds);
  for (const intent of state.adoptions) {
    const revision = graph.revisions.find(
      (candidate) => candidate.record.revision_id === intent.revision_id
    );
    if (!revision) {
      throw new Error(`Adopted revision ${intent.revision_id} was not verified.`);
    }
    if (
      intent.document_id !== null &&
      revision.record.core.document_id !== intent.document_id
    ) {
      throw new CollaborationProjectionError(
        "cross_project_dependency",
        "An adoption event names the wrong document for its revision.",
        intent.revision_id
      );
    }
    intent.document_id = revision.record.core.document_id;
  }
  const byDocument = new Map<DocumentId, AdoptionIntent[]>();
  for (const intent of state.adoptions.filter((candidate) => candidate.authorized)) {
    if (intent.document_id === null) continue;
    const entries = byDocument.get(intent.document_id) ?? [];
    entries.push(intent);
    byDocument.set(intent.document_id, entries);
  }
  const output: ProjectedDocumentRevisionHeads[] = [];
  for (const [documentId, intents] of byDocument) {
    const adoptedIds = sortedUnique(intents.map((intent) => intent.revision_id));
    const headIds = adoptedIds.filter(
      (candidate) =>
        !adoptedIds.some(
          (other) =>
            candidate !== other && isRevisionAncestor(graph, candidate, other)
        )
    );
    output.push(Object.freeze({
      document_id: documentId,
      head_revision_ids: Object.freeze(headIds),
      adoptions: Object.freeze(
        adoptedIds.map((revisionId) =>
          freezeAdoption(
            revisionId,
            intents.filter((intent) => intent.revision_id === revisionId),
            headIds.includes(revisionId),
            adoptedIds.filter(
              (other) => other !== revisionId && isRevisionAncestor(graph, revisionId, other)
            )
          )
        )
      )
    }));
  }
  return Object.freeze(output.sort((left, right) => compareStrings(left.document_id, right.document_id)));
}

function freezeAdoption(
  revisionId: DocumentRevisionId,
  intents: readonly AdoptionIntent[],
  isHead: boolean,
  supersededBy: readonly DocumentRevisionId[]
): ProjectedRevisionAdoption {
  return Object.freeze({
    revision_id: revisionId,
    adopting_event_ids: Object.freeze(sortedUnique(intents.map((intent) => intent.event_id))),
    adopting_payload_ids: Object.freeze(sortedUnique(intents.map((intent) => intent.payload_id))),
    author_device_ids: Object.freeze(sortedUnique(intents.map((intent) => intent.author_device_id))),
    author_roles: Object.freeze(sortedUnique(intents.map((intent) => intent.author_role)) as ("owner" | "editor")[]),
    attestation_ids: Object.freeze(sortedUnique(intents.flatMap((intent) => intent.attestation_ids))),
    adoption_kinds: Object.freeze(sortedUnique(intents.map((intent) => intent.adoption_kind))),
    is_head: isHead,
    superseded_by_revision_ids: Object.freeze([...supersededBy].sort())
  });
}

async function deriveConflicts(
  state: ProjectorState,
  revisionHeads: readonly ProjectedDocumentRevisionHeads[] = []
): Promise<readonly ConflictLocator[]> {
  const conflicts: ConflictLocator[] = [];
  for (const target of state.registers.values()) {
    const values = groupCandidates(target.candidates.values());
    if (values.length < 2) continue;
    const metadata = parseRegisterKey(target.key);
    conflicts.push({
      record: await buildReducerConflict(
        state,
        metadata.kind,
        metadata.id,
        metadata.field,
        conflictKindForField(metadata.field),
        values.flatMap((group) => group.events.map((entry) => entry.event_id)),
        await Promise.all(values.map((group) => valueCommitment(group.value))),
        []
      ),
      register: target
    });
  }
  for (const document of state.documents.values()) {
    await addTombstoneConflict(state, conflicts, "document", document.document_id, document.tombstone);
    for (const comment of document.comments.values()) {
      await addTombstoneConflict(state, conflicts, "comment", comment.comment_id, comment.tombstone);
      for (const reply of comment.replies.values()) {
        await addTombstoneConflict(state, conflicts, "reply", reply.reply_id, reply.tombstone);
      }
    }
  }
  await addAliasConflicts(state, conflicts);
  await addReferenceConflicts(state, conflicts);
  for (const heads of revisionHeads) {
    if (heads.head_revision_ids.length < 2) continue;
    const eventIds = heads.adoptions
      .filter((adoption) => adoption.is_head)
      .flatMap((adoption) => adoption.adopting_event_ids);
    conflicts.push({
      record: await buildReducerConflict(
        state,
        "document",
        heads.document_id,
        "revision-heads",
        "revision",
        eventIds,
        heads.head_revision_ids,
        state.documents.get(heads.document_id)?.tombstone
          ? [...(state.documents.get(heads.document_id)?.tombstone?.deletions.keys() ?? [])]
          : []
      ),
      register: null
    });
  }
  return Object.freeze(
    conflicts.sort((left, right) => compareStrings(left.record.conflict_id, right.record.conflict_id))
  );
}

async function deriveHistoricalRegisterConflict(
  state: ProjectorState,
  observedEventIds: readonly SemanticEventId[],
  expectedConflictId: string
): Promise<ConflictLocator | undefined> {
  for (const target of state.registers.values()) {
    const candidates = observedEventIds.map((eventId) => target.history.get(eventId));
    if (candidates.some((candidate) => candidate === undefined)) continue;
    const values = groupCandidates(candidates as MutableCandidate[]);
    if (values.length < 2) continue;
    const metadata = parseRegisterKey(target.key);
    const record = await buildReducerConflict(
      state,
      metadata.kind,
      metadata.id,
      metadata.field,
      conflictKindForField(metadata.field),
      observedEventIds,
      await Promise.all(values.map((group) => valueCommitment(group.value))),
      []
    );
    if (record.conflict_id === expectedConflictId) return { record, register: target };
  }
  return undefined;
}

async function addTombstoneConflict(
  state: ProjectorState,
  output: ConflictLocator[],
  kind: "document" | "comment" | "reply",
  id: string,
  tombstone: MutableTombstone | null
): Promise<void> {
  if (!tombstone || tombstone.contender_event_ids.size === 0) return;
  const deletionIds = [...tombstone.deletions.keys()].sort();
  output.push({
    record: await buildReducerConflict(
      state,
      kind,
      id,
      "tombstone",
      "tombstone",
      [...deletionIds, ...tombstone.contender_event_ids],
      await Promise.all([
        valueCommitment("permanently-deleted"),
        valueCommitment("concurrent-contender")
      ]),
      deletionIds
    ),
    register: null
  });
}

async function addAliasConflicts(
  state: ProjectorState,
  output: ConflictLocator[]
): Promise<void> {
  const claims = new Map<string, Array<{ document: MutableDocument; events: SemanticEventId[] }>>();
  for (const document of state.documents.values()) {
    for (const group of groupCandidates(document.logical_path.candidates.values())) {
      const values = claims.get(group.value) ?? [];
      values.push({
        document,
        events: group.events.map((entry) => entry.event_id)
      });
      claims.set(group.value, values);
    }
  }
  for (const [path, values] of claims) {
    if (new Set(values.map((value) => value.document.document_id)).size < 2) continue;
    output.push({
      record: await buildReducerConflict(
        state,
        "project",
        state.history.events[0]?.event.core.project_id ?? "",
        "alias-path",
        "alias_path",
        values.flatMap((value) => value.events),
        [await valueCommitment(path)],
        []
      ),
      register: null
    });
  }
}

async function addReferenceConflicts(
  state: ProjectorState,
  output: ConflictLocator[]
): Promise<void> {
  for (const document of state.documents.values()) {
    for (const [targetId, eventIds] of document.references) {
      const target = state.documents.get(targetId);
      if (target && !target.tombstone) continue;
      output.push({
        record: await buildReducerConflict(
          state,
          "document",
          document.document_id,
          "unresolved-reference",
          "unresolved_reference",
          [...eventIds],
          [await valueCommitment(targetId)],
          target?.tombstone ? [...target.tombstone.deletions.keys()] : []
        ),
        register: null
      });
    }
  }
}

async function buildReducerConflict(
  state: ProjectorState,
  subjectKind: DerivedReducerConflict["subject_kind"],
  subjectId: string,
  field: string,
  conflictKind: ReducerConflictKind,
  contenderEventIds: readonly SemanticEventId[],
  contenderCommitments: readonly string[],
  contextEventIds: readonly SemanticEventId[]
): Promise<DerivedConflictRecord> {
  const projectId = state.history.events[0]?.event.core.project_id;
  if (!projectId) throw new Error("A conflict cannot be derived without a project event.");
  const core: DerivedReducerConflict = Object.freeze({
    schema_version: DERIVED_CONFLICT_SCHEMA_VERSION,
    conflict_kind: "reducer",
    authority: "none",
    project_id: projectId,
    reducer_version: INITIAL_REDUCER_VERSION,
    reducer_conflict_kind: conflictKind,
    subject_kind: subjectKind,
    subject_id: subjectId,
    field,
    base_value_commitment: null,
    contender_event_ids: Object.freeze(sortedUnique(contenderEventIds)),
    contender_value_commitments: Object.freeze(sortedUnique(contenderCommitments)),
    context_event_ids: Object.freeze(sortedUnique(contextEventIds))
  });
  const identity = await deriveDerivedConflictIdentity(core);
  return parseDerivedConflictRecord({
    record_version: 1,
    object_kind: "derived_conflict",
    conflict_id: identity.id,
    core
  });
}

async function freezeProjection(
  state: ProjectorState,
  revisionHeads: readonly ProjectedDocumentRevisionHeads[],
  conflicts: readonly ConflictLocator[]
): Promise<CollaborationProjection> {
  const groups = await Promise.all(
    [...state.groups.values()]
      .sort((left, right) => compareStrings(left.group_id, right.group_id))
      .map(freezeGroup)
  );
  const documents = await Promise.all(
    [...state.documents.values()]
      .sort((left, right) => compareStrings(left.document_id, right.document_id))
      .map((document) => freezeDocument(state, document))
  );
  const projectId = state.history.events[0]?.event.core.project_id;
  if (!projectId) throw new Error("Projection requires at least one accepted semantic event.");
  return Object.freeze({
    schema_version: PROJECTION_SCHEMA_VERSION,
    object_kind: "collaboration_projection" as const,
    reducer_version: INITIAL_REDUCER_VERSION,
    project_id: projectId,
    project_title: await freezeRegister(state.project_title),
    group_order: Object.freeze(sortEntityOrder(groups, "group_id", "position")),
    groups: Object.freeze(groups),
    document_order: Object.freeze(sortEntityOrder(documents, "document_id", "position")),
    documents: Object.freeze(documents),
    review_batches: Object.freeze(
      await Promise.all(
        [...state.review_batches.values()]
          .sort((left, right) => compareStrings(left.review_batch_id, right.review_batch_id))
          .map(freezeReviewBatch)
      )
    ),
    rewrite_sessions: Object.freeze(
      await Promise.all(
        [...state.rewrite_sessions.values()]
          .sort((left, right) => compareStrings(left.rewrite_session_id, right.rewrite_session_id))
          .map(freezeRewriteSession)
      )
    ),
    revision_heads: revisionHeads,
    conflicts: Object.freeze(conflicts.map((entry) => entry.record)),
    reduction_rejections: Object.freeze(
      [...state.rejections].sort((left, right) => compareStrings(left.event_id, right.event_id))
    ),
    replayed_event_ids: state.history.topological_event_ids,
    accepted_frontier: state.history.accepted_frontier,
    event_provenance: Object.freeze(
      state.history.events.map((loaded) => loaded.provenance).sort((left, right) => compareStrings(left.event_id, right.event_id))
    ),
    ...(state.bootstrap_import === null
      ? {}
      : {
          bootstrap_import: Object.freeze({
            boundary_version: 1 as const,
            boundary_event_id: state.bootstrap_import.event_id,
            boundary_payload_id: state.bootstrap_import.payload_id,
            data: state.bootstrap_import.data
          })
        })
  });
}

async function freezeGroup(group: MutableGroup): Promise<ProjectedGroup> {
  return Object.freeze({
    group_id: group.group_id,
    title: await freezeRegister(group.title),
    position: await freezeRegister(group.position),
    creation_event_ids: Object.freeze([...group.creation_event_ids].sort())
  });
}

async function freezeDocument(
  state: ProjectorState,
  document: MutableDocument
): Promise<ProjectedDocument> {
  return Object.freeze({
    document_id: document.document_id,
    title: await freezeRegister(document.title),
    logical_path: await freezeRegister(document.logical_path),
    position: await freezeRegister(document.position),
    group: await freezeRegister(document.group),
    archive_status: await freezeRegister(document.archive_status),
    tombstone: freezeTombstone(document.tombstone),
    creation_event_ids: Object.freeze([...document.creation_event_ids].sort()),
    comments: Object.freeze(
      await Promise.all(
        [...document.comments.values()]
          .sort((left, right) => compareStrings(left.comment_id, right.comment_id))
          .map(freezeComment)
      )
    ),
    patches: Object.freeze(
      await Promise.all(
        [...document.patches.values()]
          .sort((left, right) => compareStrings(left.patch_id, right.patch_id))
          .map(freezePatch)
      )
    ),
    references: Object.freeze(
      [...document.references.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([targetId, eventIds]): ProjectedDocumentReference => Object.freeze({
          target_document_id: targetId,
          event_ids: Object.freeze([...eventIds].sort()),
          state: state.documents.has(targetId) && !state.documents.get(targetId)?.tombstone
            ? "available"
            : "unresolved"
        }))
    )
  });
}

async function freezeComment(comment: MutableComment): Promise<ProjectedComment> {
  return Object.freeze({
    comment_id: comment.comment_id,
    document_id: comment.document_id,
    body: await freezeRegister(comment.body),
    anchor: await freezeRegister(comment.anchor),
    status: await freezeRegister(comment.status),
    replies: Object.freeze(
      await Promise.all(
        [...comment.replies.values()]
          .sort((left, right) => compareStrings(left.reply_id, right.reply_id))
          .map(freezeReply)
      )
    ),
    tombstone: freezeTombstone(comment.tombstone),
    creation_event_ids: Object.freeze([...comment.creation_event_ids].sort())
  });
}

async function freezeReply(reply: MutableReply): Promise<ProjectedReply> {
  return Object.freeze({
    reply_id: reply.reply_id,
    comment_id: reply.comment_id,
    document_id: reply.document_id,
    body: await freezeRegister(reply.body),
    tombstone: freezeTombstone(reply.tombstone),
    creation_event_ids: Object.freeze([...reply.creation_event_ids].sort())
  });
}

async function freezePatch(patch: MutablePatch): Promise<ProjectedPatch> {
  return Object.freeze({
    patch_id: patch.patch_id,
    document_id: patch.document_id,
    versions: Object.freeze(
      await Promise.all(
        [...patch.versions.values()]
          .sort((left, right) => compareStrings(left.patch_version_id, right.patch_version_id))
          .map(freezePatchVersion)
      )
    )
  });
}

async function freezePatchVersion(version: MutablePatchVersion): Promise<ProjectedPatchVersion> {
  return Object.freeze({
    patch_version_id: version.patch_version_id,
    revision_id: version.revision_id,
    dependency_patch_version_ids: version.dependency_patch_version_ids,
    target_provenance: version.target_provenance,
    proposal_event_ids: Object.freeze([...version.proposal_event_ids].sort()),
    proposal_payload_ids: Object.freeze([...version.proposal_payload_ids].sort()),
    decision: await freezeRegister(version.decision)
  });
}

async function freezeReviewBatch(batch: MutableReviewBatch): Promise<ProjectedReviewBatch> {
  return Object.freeze({
    review_batch_id: batch.review_batch_id,
    lifecycle: await freezeRegister(batch.lifecycle),
    responses: await freezeRegister(batch.responses),
    contribution_payload_ids: Object.freeze([...batch.contribution_payload_ids].sort()),
    creation_event_ids: Object.freeze([...batch.creation_event_ids].sort())
  });
}

async function freezeRewriteSession(session: MutableRewriteSession): Promise<ProjectedRewriteSession> {
  return Object.freeze({
    rewrite_session_id: session.rewrite_session_id,
    document_id: session.document_id,
    outcome: await freezeRegister(session.outcome),
    applied_revision_ids: Object.freeze([...session.applied_revision_ids].sort()),
    creation_event_ids: Object.freeze([...session.creation_event_ids].sort())
  });
}

async function freezeRegister(target: MutableRegister): Promise<ProjectedValueRegister> {
  const groups = groupCandidates(target.candidates.values());
  return Object.freeze({
    register_version: 1,
    state: groups.length === 0 ? "unset" : groups.length === 1 ? "resolved" : "conflicted",
    resolved_value: groups.length === 1 ? groups[0].value : null,
    last_uncontested_value: target.last_uncontested_value,
    contenders: Object.freeze(
      await Promise.all(
        groups.map(async (group) => Object.freeze({
          value: group.value,
          value_commitment: await valueCommitment(group.value),
          event_ids: Object.freeze(group.events.map((entry) => entry.event_id).sort()),
          payload_ids: Object.freeze(sortedUnique(group.events.map((entry) => entry.payload_id)))
        }))
      )
    )
  });
}

function freezeTombstone(tombstone: MutableTombstone | null): ProjectedTombstone | null {
  if (!tombstone) return null;
  return Object.freeze({
    tombstone_version: 1,
    deletion_event_ids: Object.freeze([...tombstone.deletions.keys()].sort()),
    deletion_payload_ids: Object.freeze(sortedUnique([...tombstone.deletions.values()])),
    contender_event_ids: Object.freeze([...tombstone.contender_event_ids].sort())
  });
}

function register(registers: Map<string, MutableRegister>, key: string): MutableRegister {
  const existing = registers.get(key);
  if (existing) return existing;
  const value: MutableRegister = {
    key,
    candidates: new Map(),
    history: new Map(),
    last_uncontested_value: null
  };
  registers.set(key, value);
  return value;
}

function ensureDocument(state: ProjectorState, id: DocumentId): MutableDocument {
  const existing = state.documents.get(id);
  if (existing) return existing;
  const value: MutableDocument = {
    document_id: id,
    title: register(state.registers, `document|${id}|title`),
    logical_path: register(state.registers, `document|${id}|logical-path`),
    position: register(state.registers, `document|${id}|position`),
    group: register(state.registers, `document|${id}|group`),
    archive_status: register(state.registers, `document|${id}|archive-status`),
    tombstone: null,
    creation_event_ids: new Set(),
    comments: new Map(),
    patches: new Map(),
    references: new Map()
  };
  state.documents.set(id, value);
  return value;
}

function ensureGroup(state: ProjectorState, id: GroupId): MutableGroup {
  const existing = state.groups.get(id);
  if (existing) return existing;
  const value: MutableGroup = {
    group_id: id,
    title: register(state.registers, `group|${id}|title`),
    position: register(state.registers, `group|${id}|position`),
    creation_event_ids: new Set()
  };
  state.groups.set(id, value);
  return value;
}

function ensureComment(
  document: MutableDocument,
  registers: Map<string, MutableRegister>,
  id: CommentId
): MutableComment {
  const existing = document.comments.get(id);
  if (existing) return existing;
  const value: MutableComment = {
    comment_id: id,
    document_id: document.document_id,
    body: register(registers, `comment|${id}|body`),
    anchor: register(registers, `comment|${id}|anchor`),
    status: register(registers, `comment|${id}|status`),
    replies: new Map(),
    tombstone: null,
    creation_event_ids: new Set()
  };
  document.comments.set(id, value);
  return value;
}

function ensureReply(
  comment: MutableComment,
  registers: Map<string, MutableRegister>,
  id: ReplyId
): MutableReply {
  const existing = comment.replies.get(id);
  if (existing) return existing;
  const value: MutableReply = {
    reply_id: id,
    comment_id: comment.comment_id,
    document_id: comment.document_id,
    body: register(registers, `reply|${id}|body`),
    tombstone: null,
    creation_event_ids: new Set()
  };
  comment.replies.set(id, value);
  return value;
}

function ensurePatch(document: MutableDocument, id: PatchId): MutablePatch {
  const existing = document.patches.get(id);
  if (existing) return existing;
  const value: MutablePatch = {
    patch_id: id,
    document_id: document.document_id,
    versions: new Map()
  };
  document.patches.set(id, value);
  return value;
}

function ensurePatchVersion(
  patch: MutablePatch,
  registers: Map<string, MutableRegister>,
  id: PatchVersionId
): MutablePatchVersion {
  const existing = patch.versions.get(id);
  if (existing) return existing;
  const value: MutablePatchVersion = {
    patch_version_id: id,
    revision_id: null,
    dependency_patch_version_ids: Object.freeze([]),
    target_provenance: null,
    proposal_event_ids: new Set(),
    proposal_payload_ids: new Set(),
    decision: register(
      registers,
      `patch|${patch.patch_id}|decision-${id.slice(id.lastIndexOf(":") + 1)}`
    )
  };
  patch.versions.set(id, value);
  return value;
}

function ensureReviewBatch(state: ProjectorState, id: ReviewBatchId): MutableReviewBatch {
  const existing = state.review_batches.get(id);
  if (existing) return existing;
  const value: MutableReviewBatch = {
    review_batch_id: id,
    lifecycle: register(state.registers, `review_batch|${id}|lifecycle`),
    responses: register(state.registers, `review_batch|${id}|response`),
    contribution_payload_ids: new Set(),
    creation_event_ids: new Set()
  };
  state.review_batches.set(id, value);
  return value;
}

function ensureRewriteSession(
  state: ProjectorState,
  id: RewriteSessionId,
  documentId: DocumentId
): MutableRewriteSession {
  const existing = state.rewrite_sessions.get(id);
  if (existing) return existing;
  const value: MutableRewriteSession = {
    rewrite_session_id: id,
    document_id: documentId,
    outcome: register(state.registers, `rewrite_session|${id}|outcome`),
    applied_revision_ids: new Set(),
    creation_event_ids: new Set()
  };
  state.rewrite_sessions.set(id, value);
  return value;
}

function observesCreation(
  state: ProjectorState,
  eventId: SemanticEventId,
  creationIds: ReadonlySet<SemanticEventId>
): boolean {
  return [...creationIds].some(
    (creationId) =>
      creationId === eventId ||
      compareSemanticEventCausality(state.history.ancestry, creationId, eventId) ===
        "causally_before"
  );
}

function adoptionIntent(
  loaded: LoadedProjectionEvent,
  revisionId: DocumentRevisionId,
  documentId: DocumentId | null,
  kind: AdoptionKind
): AdoptionIntent {
  return {
    revision_id: revisionId,
    document_id: documentId,
    event_id: loaded.event.event_id,
    payload_id: loaded.payload.payload_id,
    author_device_id: loaded.provenance.author_device_id,
    author_role: loaded.provenance.author_role,
    attestation_ids: loaded.event.author_attestation_ids,
    adoption_kind: kind,
    authorized:
      loaded.provenance.author_role === "owner" ||
      loaded.provenance.author_role === "editor"
  };
}

function reject(
  state: ProjectorState,
  loaded: LoadedProjectionEvent,
  reason: ProjectionReductionRejection["reason"],
  detail: string
): void {
  if (state.rejections.some((entry) => entry.event_id === loaded.event.event_id)) return;
  state.rejections.push(Object.freeze({
    rejection_version: 1,
    event_id: loaded.event.event_id,
    payload_id: loaded.payload.payload_id,
    reason,
    detail
  }));
}

function groupCandidates(values: Iterable<MutableCandidate>): Array<{
  value: string;
  events: MutableCandidate[];
}> {
  const groups = new Map<string, MutableCandidate[]>();
  for (const candidate of values) {
    const entries = groups.get(candidate.value) ?? [];
    entries.push(candidate);
    groups.set(candidate.value, entries);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([value, events]) => ({
      value,
      events: events.sort((left, right) => compareStrings(left.event_id, right.event_id))
    }));
}

function parseRegisterKey(key: string): {
  kind: DerivedReducerConflict["subject_kind"];
  id: string;
  field: string;
} {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  if (first <= 0 || last <= first) throw new Error(`Invalid reducer register key ${key}.`);
  return {
    kind: key.slice(0, first) as DerivedReducerConflict["subject_kind"],
    id: key.slice(first + 1, last),
    field: key.slice(last + 1)
  };
}

function conflictKindForField(field: string): ReducerConflictKind {
  if (field.startsWith("decision-")) return "decision";
  if (field === "status" || field === "archive-status") return "status";
  if (field === "lifecycle" || field === "outcome") return "lifecycle";
  return "field_value";
}

const valueCommitmentCache = new Map<string, Promise<string>>();

function valueCommitment(value: string): Promise<string> {
  const existing = valueCommitmentCache.get(value);
  if (existing) return existing;
  const pending = sha256(
    new TextEncoder().encode(`patchmark/projection-value/v1\u0000${value}`)
  ).then((digest) => `sha256:${bytesToHex(digest)}`);
  valueCommitmentCache.set(value, pending);
  return pending;
}

function sortEntityOrder<
  T extends Readonly<Record<TId | TPosition, unknown>>,
  TId extends string,
  TPosition extends string
>(values: readonly T[], idKey: TId, positionKey: TPosition): Array<T[TId] & string> {
  return [...values]
    .sort((left, right) => {
      const leftPosition = left[positionKey] as ProjectedValueRegister;
      const rightPosition = right[positionKey] as ProjectedValueRegister;
      return compareStrings(
        leftPosition.resolved_value ?? "\uffff",
        rightPosition.resolved_value ?? "\uffff"
      ) || compareStrings(left[idKey] as string, right[idKey] as string);
    })
    .map((value) => value[idKey] as T[TId] & string);
}

function requireRevisionResolutionDocument(
  state: ProjectorState,
  revisionId: DocumentRevisionId
): DocumentId {
  const intent = state.adoptions.find((candidate) => candidate.revision_id === revisionId);
  if (!intent?.document_id) {
    throw new Error("A revision conflict resolution must name a known document revision.");
  }
  return intent.document_id;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import assert from "node:assert/strict";

import {
  INITIAL_MERGE_ALGORITHM_ID,
  INITIAL_MERGE_ALGORITHM_VERSION,
  calculateMarkdownMergeCandidate,
  capabilitiesForRole,
  compareSemanticEventCausality,
  deriveAttestationIdentity,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveMergeAuthorizationEligibility,
  deriveMergeKeyIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity,
  loadProjectionHistory,
  parseAttestationRecord,
  parseCollaborationProjection,
  parseDocumentRevisionCore,
  parseSemanticEventCoreStructure,
  parseSemanticPayloadCore,
  projectCollaborationHistory,
  rebuildCollaborationProjection
} from "../lib/collaboration/index.ts";
import { evaluateCollaborationMergeVector } from "./collaboration-merge-vector-runtime.ts";

const markers = "abcdefghijklmnopqrstuvwxyz234567";
const encoder = new TextEncoder();
let assertions = 0;

function check(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

class ProjectionFixture {
  constructor() {
    this.project = entity("project", "a");
    this.controlHead = digest("control-event", "a");
    this.events = new Map();
    this.payloads = new Map();
    this.attestations = new Map();
    this.revisions = new Map();
    this.blobs = new Map();
    this.previousByDevice = new Map();
    this.sequenceByDevice = new Map();
    this.roles = new Map();
    this.deviceKeys = new Map();
    this.accepted = [];
    this.readCounts = {
      attestations: 0,
      blobs: 0,
      events: 0,
      payloads: 0,
      revisions: 0
    };
    this.device("a", "owner");
  }

  device(marker, role = "editor") {
    const id = entity("device", marker);
    this.roles.set(id, role);
    this.deviceKeys.set(id, entity("public-key", marker));
    return id;
  }

  async addRevision(documentId, markdown, parents = [], ancestryKind = "ordinary") {
    const bytes = typeof markdown === "string" ? encoder.encode(markdown) : Uint8Array.from(markdown);
    const blobIdentity = await deriveMarkdownBlobIdentity(this.project, bytes);
    this.blobs.set(blobIdentity.id, Object.freeze({
      schema_version: 1,
      object_kind: "markdown_blob",
      project_id: this.project,
      blob_id: blobIdentity.id,
      encoding: "utf-8-exact",
      bytes: Uint8Array.from(bytes)
    }));
    const core = parseDocumentRevisionCore({
      schema_version: 1,
      object_kind: "document_revision_core",
      ancestry_kind: ancestryKind,
      project_id: this.project,
      document_id: documentId,
      markdown_blob_id: blobIdentity.id,
      parent_revision_ids: [...parents].sort()
    });
    const identity = await deriveDocumentRevisionIdentity(core);
    this.revisions.set(identity.id, Object.freeze({
      record_version: 1,
      object_kind: "document_revision",
      revision_id: identity.id,
      core
    }));
    return identity.id;
  }

  async initialize(markdown = "# Document\n") {
    const documentId = entity("document", "a");
    const revisionId = await this.addRevision(documentId, markdown, [], "genesis");
    const event = await this.addEvent({
      device: this.device("a", "owner"),
      semanticKind: "project_genesis",
      data: { genesis_revision_ids: [revisionId] },
      parents: []
    });
    this.genesisEventId = event.event_id;
    this.documentId = documentId;
    this.genesisRevisionId = revisionId;
    return { documentId, eventId: event.event_id, revisionId };
  }

  async addEvent({ device, semanticKind, data, parents, timestamp }) {
    const payloadCore = parseSemanticPayloadCore({
      schema_version: 1,
      project_id: this.project,
      semantic_kind: semanticKind,
      data
    });
    const payloadIdentity = await deriveSemanticPayloadIdentity(payloadCore);
    const payload = Object.freeze({
      record_version: 1,
      object_kind: "semantic_payload",
      payload_id: payloadIdentity.id,
      core: payloadCore
    });
    this.payloads.set(payload.payload_id, payload);

    const previous = this.previousByDevice.get(device) ?? null;
    const sequence = this.sequenceByDevice.get(device) ?? 0;
    const causalParents = [...new Set([
      ...parents,
      ...(previous === null ? [] : [previous])
    ])].sort();
    const eventCore = parseSemanticEventCoreStructure({
      schema_version: 1,
      object_kind: "semantic_event_core",
      device_chain_position: previous === null ? "first" : "subsequent",
      project_id: this.project,
      semantic_kind: semanticKind,
      author_device_id: device,
      device_sequence: BigInt(sequence),
      previous_device_event_id: previous,
      causal_parent_event_ids: causalParents,
      authorizing_control_head_id: this.controlHead,
      key_epoch_id: entity("key-epoch", "a"),
      semantic_payload_id: payload.payload_id,
      complete_known_frontier: true,
      ...(timestamp === undefined ? {} : { display_timestamp: timestamp })
    });
    const eventIdentity = await deriveSemanticEventCoreIdentity(eventCore);
    const attestationCore = {
      schema_version: 1,
      object_kind: "attestation_core",
      project_id: this.project,
      subject_kind: "semantic_event",
      subject_id: eventIdentity.id,
      signer_key_id: this.deviceKeys.get(device),
      algorithm: "ed25519",
      signature_bytes: Uint8Array.of((sequence + causalParents.length + 1) % 255)
    };
    const attestationIdentity = await deriveAttestationIdentity(attestationCore);
    const attestation = parseAttestationRecord({
      record_version: 1,
      object_kind: "attestation",
      attestation_id: attestationIdentity.id,
      core: attestationCore
    });
    this.attestations.set(attestation.attestation_id, attestation);
    const event = Object.freeze({
      record_version: 1,
      object_kind: "semantic_event",
      event_id: eventIdentity.id,
      core: eventCore,
      author_attestation_ids: Object.freeze([attestation.attestation_id])
    });
    this.events.set(event.event_id, event);
    this.previousByDevice.set(device, event.event_id);
    this.sequenceByDevice.set(device, sequence + 1);
    this.accepted.push(event.event_id);
    return event;
  }

  input(order = this.accepted) {
    const frontier = new Set(this.accepted);
    for (const event of this.events.values()) {
      for (const parent of event.core.causal_parent_event_ids) frontier.delete(parent);
    }
    const input = {
      project_id: this.project,
      accepted_semantic_event_ids: [...order],
      accepted_semantic_frontier: [...frontier].sort(),
      accepted_control_facts: [{
        control_event_id: this.controlHead,
        merge_policy: "manual",
        device_authorities: [...this.roles.entries()]
          .map(([deviceId, role]) => ({
            device_id: deviceId,
            person_id: entity("person", deviceId.slice(-2, -1)),
            signing_key_id: this.deviceKeys.get(deviceId),
            role,
            capabilities: capabilitiesForRole(role),
            status: "active",
            maximum_accepted_semantic_sequence: null
          }))
          .sort((left, right) => left.device_id < right.device_id ? -1 : 1)
      }],
      onboarding_boundaries: [],
      read_event: async (id) => {
        this.readCounts.events += 1;
        return validOrMissing(this.events.get(id), "event missing");
      },
      read_payload: async (id) => {
        this.readCounts.payloads += 1;
        return validOrMissing(this.payloads.get(id), "payload missing");
      },
      read_revision: async (id) => {
        this.readCounts.revisions += 1;
        return validOrMissing(this.revisions.get(id), "revision missing");
      },
      read_blob: async (projectId, id) => {
        this.readCounts.blobs += 1;
        if (projectId !== this.project) {
          return { status: "mismatched", reason: "wrong project" };
        }
        return validOrMissing(this.blobs.get(id), "blob missing");
      },
      read_attestation: async (id) => {
        this.readCounts.attestations += 1;
        return validOrMissing(this.attestations.get(id), "attestation missing");
      }
    };
    Object.defineProperties(input, {
      append_event: { get: writeTrap },
      allocate_sequence: { get: writeTrap },
      materialize_markdown: { get: writeTrap },
      put_revision: { get: writeTrap },
      quarantine: { get: writeTrap },
      sign: { get: writeTrap },
      write_file: { get: writeTrap }
    });
    return input;
  }
}

await testCausalityReplayAndPurity();
await testCommentReplyAndTombstoneReducers();
await testConflictResolutionAndLateContender();
await testMetadataOrderingAliasAndReferences();
await testPatchReviewRewriteAndRevisionHeads();
await testRevisionAdoptionRejections();
await testMergeCandidatesAndAuthority();
await testFailClosedDependencies();

process.stdout.write(`${JSON.stringify({
  assertions,
  deterministic_permutations: 20,
  reducer_families: 8,
  merge_classifications: 6,
  purity_traps_untouched: true
}, null, 2)}\n`);

async function testCausalityReplayAndPurity() {
  const fixture = new ProjectionFixture();
  const { eventId } = await fixture.initialize();
  const sequential = await fixture.addEvent({
    device: fixture.device("a", "owner"),
    semanticKind: "metadata_operation",
    data: { operation: "project_title", value: "Observed title" },
    parents: [eventId],
    timestamp: "2099-01-01T00:00:00Z"
  });
  const concurrent = await fixture.addEvent({
    device: fixture.device("b", "editor"),
    semanticKind: "metadata_operation",
    data: { operation: "project_title", value: "Concurrent title" },
    parents: [eventId],
    timestamp: "1999-01-01T00:00:00Z"
  });
  const history = await loadProjectionHistory(fixture.input());
  check(
    compareSemanticEventCausality(history.ancestry, eventId, sequential.event_id),
    "causally_before",
    "same-device ancestry must establish causality"
  );
  check(
    compareSemanticEventCausality(history.ancestry, sequential.event_id, concurrent.event_id),
    "concurrent",
    "cross-device siblings must remain concurrent"
  );
  check(
    compareSemanticEventCausality(history.ancestry, eventId, concurrent.event_id),
    "causally_before",
    "an explicit cross-device parent must establish causality"
  );
  const baseline = await projectCollaborationHistory(fixture.input());
  check(parseCollaborationProjection(baseline.projection), baseline.projection);
  assert.throws(() => parseCollaborationProjection({
    ...baseline.projection,
    device_private_state: {}
  }), /unexpected field/);
  assertions += 1;
  assert.throws(() => parseCollaborationProjection({
    ...baseline.projection,
    schema_version: 99
  }), /version/);
  assertions += 1;
  check(baseline.projection.project_title.state, "conflicted");
  check(baseline.projection.project_title.last_uncontested_value, null);
  check("display_timestamp" in baseline.projection, false, "timestamps must not enter projection");
  const duplicate = await projectCollaborationHistory(
    fixture.input([...fixture.accepted, concurrent.event_id, sequential.event_id])
  );
  check(stableProjection(duplicate.projection), stableProjection(baseline.projection));
  const rebuilt = await rebuildCollaborationProjection(fixture.input(), baseline.projection);
  check(stableProjection(rebuilt.projection), stableProjection(baseline.projection));
  for (const order of deterministicPermutations(fixture.accepted, 20)) {
    const replay = await projectCollaborationHistory(fixture.input(order));
    check(stableProjection(replay.projection), stableProjection(baseline.projection));
  }
  ok(fixture.readCounts.attestations > 0, "projector must verify accepted attestation provenance");
}

async function testCommentReplyAndTombstoneReducers() {
  const fixture = new ProjectionFixture();
  const { eventId, documentId } = await fixture.initialize();
  const commentId = entity("comment", "a");
  const create = await fixture.addEvent({
    device: fixture.device("b"),
    semanticKind: "comment_operation",
    data: {
      operation: "create",
      document_id: documentId,
      comment_id: commentId,
      content: "Base body",
      anchor: { anchor_kind: "section", anchor_key: "intro" }
    },
    parents: [eventId]
  });
  const editOne = await fixture.addEvent({
    device: fixture.device("c"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, content: "Body one" },
    parents: [create.event_id]
  });
  const editTwo = await fixture.addEvent({
    device: fixture.device("d"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, content: "Body two" },
    parents: [create.event_id]
  });
  const resolve = await fixture.addEvent({
    device: fixture.device("e"),
    semanticKind: "comment_operation",
    data: { operation: "resolve", document_id: documentId, comment_id: commentId },
    parents: [create.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("f"),
    semanticKind: "comment_operation",
    data: { operation: "reopen", document_id: documentId, comment_id: commentId },
    parents: [create.event_id]
  });
  const replyId = entity("reply", "a");
  const reply = await fixture.addEvent({
    device: fixture.device("g"),
    semanticKind: "reply_operation",
    data: { operation: "create", document_id: documentId, comment_id: commentId, reply_id: replyId, content: "Reply" },
    parents: [create.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("h"),
    semanticKind: "reply_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, reply_id: replyId, content: "Reply A" },
    parents: [reply.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("i"),
    semanticKind: "reply_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, reply_id: replyId, content: "Reply B" },
    parents: [reply.event_id]
  });
  const secondComment = entity("comment", "b");
  const secondCreate = await fixture.addEvent({
    device: fixture.device("j"),
    semanticKind: "comment_operation",
    data: { operation: "create", document_id: documentId, comment_id: secondComment, content: "Same" },
    parents: [eventId]
  });
  await fixture.addEvent({
    device: fixture.device("k"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: secondComment, content: "Identical" },
    parents: [secondCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("l"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: secondComment, content: "Identical" },
    parents: [secondCreate.event_id]
  });
  const deleteEvent = await fixture.addEvent({
    device: fixture.device("m"),
    semanticKind: "comment_operation",
    data: { operation: "delete", document_id: documentId, comment_id: secondComment },
    parents: [secondCreate.event_id]
  });
  const reanchor = await fixture.addEvent({
    device: fixture.device("n"),
    semanticKind: "comment_operation",
    data: {
      operation: "reanchor",
      document_id: documentId,
      comment_id: secondComment,
      anchor: { anchor_kind: "selected_text", anchor_key: "selection:1" }
    },
    parents: [secondCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("n"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: secondComment, content: "Resurrection attempt" },
    parents: [reanchor.event_id, deleteEvent.event_id]
  });
  const commutingComment = entity("comment", "e");
  const commutingCreate = await fixture.addEvent({
    device: fixture.device("o"),
    semanticKind: "comment_operation",
    data: { operation: "create", document_id: documentId, comment_id: commutingComment, content: "Before" },
    parents: [eventId]
  });
  await fixture.addEvent({
    device: fixture.device("p"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commutingComment, content: "After" },
    parents: [commutingCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("q"),
    semanticKind: "comment_operation",
    data: { operation: "resolve", document_id: documentId, comment_id: commutingComment },
    parents: [commutingCreate.event_id]
  });
  const orderedComment = entity("comment", "f");
  const orderedCreate = await fixture.addEvent({
    device: fixture.device("r"),
    semanticKind: "comment_operation",
    data: { operation: "create", document_id: documentId, comment_id: orderedComment, content: "Ordered" },
    parents: [eventId]
  });
  const orderedResolve = await fixture.addEvent({
    device: fixture.device("s"),
    semanticKind: "comment_operation",
    data: { operation: "resolve", document_id: documentId, comment_id: orderedComment },
    parents: [orderedCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("t"),
    semanticKind: "comment_operation",
    data: { operation: "reopen", document_id: documentId, comment_id: orderedComment },
    parents: [orderedResolve.event_id]
  });
  const projection = (await projectCollaborationHistory(fixture.input())).projection;
  const document = projection.documents.find((entry) => entry.document_id === documentId);
  const first = document.comments.find((entry) => entry.comment_id === commentId);
  const second = document.comments.find((entry) => entry.comment_id === secondComment);
  const commuting = document.comments.find((entry) => entry.comment_id === commutingComment);
  const ordered = document.comments.find((entry) => entry.comment_id === orderedComment);
  check(first.body.state, "conflicted", "concurrent comment edits must conflict");
  check(first.status.state, "conflicted", "resolve/reopen must conflict");
  check(first.replies[0].body.state, "conflicted", "concurrent reply edits must conflict");
  check(second.body.state, "resolved", "identical concurrent edits must deduplicate");
  check(second.body.contenders[0].event_ids.length, 2);
  check(second.tombstone.deletion_event_ids, [deleteEvent.event_id]);
  ok(second.tombstone.contender_event_ids.includes(reanchor.event_id));
  ok(projection.reduction_rejections.some((entry) => entry.reason === "permanently_deleted"));
  check(commuting.body.resolved_value, "After", "body edit must commute with resolve");
  check(commuting.status.resolved_value, "resolved");
  check(ordered.status.resolved_value, "open", "causally later reopen must win");
  ok(projection.conflicts.some((entry) => entry.core.conflict_kind === "reducer" && entry.core.reducer_conflict_kind === "tombstone"));
  const ids = projection.conflicts.map((entry) => entry.conflict_id);
  const reversed = (await projectCollaborationHistory(fixture.input([...fixture.accepted].reverse()))).projection;
  check(reversed.conflicts.map((entry) => entry.conflict_id), ids, "conflict IDs must survive arrival permutations");
  void editOne;
  void editTwo;
  void resolve;
}

async function testConflictResolutionAndLateContender() {
  const fixture = new ProjectionFixture();
  const { eventId, documentId } = await fixture.initialize();
  const commentId = entity("comment", "c");
  const create = await fixture.addEvent({
    device: fixture.device("b"),
    semanticKind: "comment_operation",
    data: { operation: "create", document_id: documentId, comment_id: commentId, content: "Base" },
    parents: [eventId]
  });
  const left = await fixture.addEvent({
    device: fixture.device("c"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, content: "Left" },
    parents: [create.event_id]
  });
  const right = await fixture.addEvent({
    device: fixture.device("d"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, content: "Right" },
    parents: [create.event_id]
  });
  const initial = (await projectCollaborationHistory(fixture.input())).projection;
  const originalConflict = initial.conflicts.find(
    (entry) => entry.core.conflict_kind === "reducer" && entry.core.field === "body"
  );
  ok(originalConflict, "comment body conflict must be derivable before resolution");
  const late = await fixture.addEvent({
    device: fixture.device("e"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: documentId, comment_id: commentId, content: "Late concurrent" },
    parents: [create.event_id]
  });
  const resolution = await fixture.addEvent({
    device: fixture.device("f"),
    semanticKind: "conflict_resolution",
    data: {
      conflict_id: originalConflict.conflict_id,
      adopted_revision_id: null,
      observed_contender_event_ids: [left.event_id, right.event_id].sort(),
      adopted_event_id: left.event_id
    },
    parents: [left.event_id, right.event_id]
  });
  const projected = (await projectCollaborationHistory(fixture.input())).projection;
  const body = projected.documents[0].comments[0].body;
  check(body.state, "conflicted", "a late unseen contender must survive an exact resolution");
  ok(body.contenders.some((entry) => entry.event_ids.includes(late.event_id)));
  ok(body.contenders.some((entry) => entry.event_ids.includes(resolution.event_id)));
  check(projected.conflicts.some((entry) => entry.conflict_id === originalConflict.conflict_id), false);

  const incompatible = new ProjectionFixture();
  const base = await incompatible.initialize();
  const comment = entity("comment", "d");
  const created = await incompatible.addEvent({
    device: incompatible.device("b"),
    semanticKind: "comment_operation",
    data: { operation: "create", document_id: base.documentId, comment_id: comment, content: "Base" },
    parents: [base.eventId]
  });
  const first = await incompatible.addEvent({
    device: incompatible.device("c"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: base.documentId, comment_id: comment, content: "First" },
    parents: [created.event_id]
  });
  const second = await incompatible.addEvent({
    device: incompatible.device("d"),
    semanticKind: "comment_operation",
    data: { operation: "edit", document_id: base.documentId, comment_id: comment, content: "Second" },
    parents: [created.event_id]
  });
  const conflict = (await projectCollaborationHistory(incompatible.input())).projection.conflicts.find(
    (entry) => entry.core.conflict_kind === "reducer" && entry.core.field === "body"
  );
  const contenderIds = [first.event_id, second.event_id].sort();
  await incompatible.addEvent({
    device: incompatible.device("e"),
    semanticKind: "conflict_resolution",
    data: { conflict_id: conflict.conflict_id, adopted_revision_id: null, observed_contender_event_ids: contenderIds, adopted_event_id: first.event_id },
    parents: contenderIds
  });
  await incompatible.addEvent({
    device: incompatible.device("f"),
    semanticKind: "conflict_resolution",
    data: { conflict_id: conflict.conflict_id, adopted_revision_id: null, observed_contender_event_ids: contenderIds, adopted_event_id: second.event_id },
    parents: contenderIds
  });
  const incompatibleProjection = (await projectCollaborationHistory(incompatible.input())).projection;
  check(incompatibleProjection.documents[0].comments[0].body.state, "conflicted", "concurrent incompatible resolutions must conflict");
}

async function testMetadataOrderingAliasAndReferences() {
  const fixture = new ProjectionFixture();
  const { eventId, documentId } = await fixture.initialize();
  const documentTwo = entity("document", "b");
  const createTwo = await fixture.addEvent({
    device: fixture.device("b"),
    semanticKind: "metadata_operation",
    data: { operation: "document_create", document_id: documentTwo },
    parents: [eventId]
  });
  const groupId = entity("group", "a");
  const group = await fixture.addEvent({
    device: fixture.device("c"),
    semanticKind: "metadata_operation",
    data: { operation: "group_create", group_id: groupId, value: "Group" },
    parents: [eventId]
  });
  await concurrentMetadata(fixture, eventId, "project_title", {}, "One", "d");
  await concurrentMetadata(fixture, eventId, "project_title", {}, "Two", "e");
  await concurrentMetadata(fixture, group.event_id, "group_rename", { group_id: groupId }, "Group A", "f");
  await concurrentMetadata(fixture, group.event_id, "group_rename", { group_id: groupId }, "Group B", "g");
  await concurrentMetadata(fixture, eventId, "document_title", { document_id: documentId }, "Title A", "h");
  await concurrentMetadata(fixture, eventId, "document_title", { document_id: documentId }, "Title B", "i");
  await concurrentMetadata(fixture, eventId, "document_archive", { document_id: documentId }, undefined, "j");
  await concurrentMetadata(fixture, eventId, "document_restore", { document_id: documentId }, undefined, "k");
  await concurrentMetadata(fixture, eventId, "document_path", { document_id: documentId }, "shared.md", "l");
  await concurrentMetadata(fixture, createTwo.event_id, "document_path", { document_id: documentTwo }, "shared.md", "m");
  await concurrentMetadata(fixture, eventId, "document_position", { document_id: documentId }, "b", "n");
  await concurrentMetadata(fixture, createTwo.event_id, "document_position", { document_id: documentTwo }, "a", "o");
  await concurrentMetadata(fixture, group.event_id, "group_position", { group_id: groupId }, "a", "p");
  await concurrentMetadata(fixture, eventId, "document_reference", { document_id: documentId, target_document_id: documentTwo }, undefined, "q");
  const deletion = await fixture.addEvent({
    device: fixture.device("r"),
    semanticKind: "metadata_operation",
    data: { operation: "document_delete", document_id: documentTwo },
    parents: [createTwo.event_id]
  });
  const concurrentTitle = await concurrentMetadata(
    fixture,
    createTwo.event_id,
    "document_title",
    { document_id: documentTwo },
    "Deleted title",
    "s"
  );
  const documentThree = entity("document", "c");
  const createThree = await fixture.addEvent({
    device: fixture.device("t"),
    semanticKind: "metadata_operation",
    data: { operation: "document_create", document_id: documentThree },
    parents: [eventId]
  });
  const archiveThree = await fixture.addEvent({
    device: fixture.device("u"),
    semanticKind: "metadata_operation",
    data: { operation: "document_archive", document_id: documentThree },
    parents: [createThree.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("v"),
    semanticKind: "metadata_operation",
    data: { operation: "document_restore", document_id: documentThree },
    parents: [archiveThree.event_id]
  });
  await concurrentMetadata(fixture, createThree.event_id, "document_position", { document_id: documentThree }, "c", "w");
  await concurrentMetadata(fixture, createThree.event_id, "document_position", { document_id: documentThree }, "d", "x");
  const projection = (await projectCollaborationHistory(fixture.input())).projection;
  check(projection.project_title.state, "conflicted");
  check(projection.groups[0].title.state, "conflicted");
  const first = projection.documents.find((entry) => entry.document_id === documentId);
  const second = projection.documents.find((entry) => entry.document_id === documentTwo);
  const third = projection.documents.find((entry) => entry.document_id === documentThree);
  check(first.title.state, "conflicted");
  check(first.archive_status.state, "conflicted");
  check(projection.document_order, [documentTwo, documentId, documentThree]);
  ok(second.tombstone.contender_event_ids.includes(concurrentTitle.event_id));
  check(first.references[0].state, "unresolved");
  check(third.archive_status.resolved_value, "active", "causally later restore must win");
  check(third.position.state, "conflicted", "same-item concurrent movement must conflict");
  ok(projection.conflicts.some((entry) => entry.core.conflict_kind === "reducer" && entry.core.reducer_conflict_kind === "alias_path"));
  ok(projection.conflicts.some((entry) => entry.core.conflict_kind === "reducer" && entry.core.reducer_conflict_kind === "unresolved_reference"));
  void deletion;
}

async function testPatchReviewRewriteAndRevisionHeads() {
  const fixture = new ProjectionFixture();
  const { eventId, documentId, revisionId } = await fixture.initialize("# Base\n");
  const branchA = await fixture.addRevision(documentId, "# Branch A\n", [revisionId]);
  const branchB = await fixture.addRevision(documentId, "# Branch B\n", [revisionId]);
  const mergeRevision = await fixture.addRevision(documentId, "# Merged\n", [branchA, branchB]);
  const adoptA = await fixture.addEvent({
    device: fixture.device("b"),
    semanticKind: "revision_adoption",
    data: { document_id: documentId, revision_id: branchA },
    parents: [eventId]
  });
  const adoptB = await fixture.addEvent({
    device: fixture.device("c"),
    semanticKind: "revision_adoption",
    data: { document_id: documentId, revision_id: branchB },
    parents: [eventId]
  });
  const beforeMerge = (await projectCollaborationHistory(fixture.input())).projection;
  check(beforeMerge.revision_heads[0].head_revision_ids, [branchA, branchB].sort());
  check(beforeMerge.revision_heads[0].head_revision_ids.includes(mergeRevision), false, "stored merge must not be adopted");

  const patchId = entity("patch", "a");
  const patchVersion = entity("patch-version", "a");
  const propose = await fixture.addEvent({
    device: fixture.device("d"),
    semanticKind: "patch_operation",
    data: {
      operation: "propose",
      document_id: documentId,
      patch_id: patchId,
      patch_version_id: patchVersion,
      revision_id: branchA,
      dependency_patch_version_ids: [],
      target_provenance: "unique:heading-a"
    },
    parents: [eventId]
  });
  const acceptedDecision = await fixture.addEvent({
    device: fixture.device("e"),
    semanticKind: "patch_operation",
    data: { operation: "decide", document_id: documentId, patch_id: patchId, patch_version_id: patchVersion, decision: "accepted" },
    parents: [propose.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("f"),
    semanticKind: "patch_operation",
    data: { operation: "decide", document_id: documentId, patch_id: patchId, patch_version_id: patchVersion, decision: "rejected" },
    parents: [propose.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("p"),
    semanticKind: "patch_operation",
    data: { operation: "edit", document_id: documentId, patch_id: patchId, patch_version_id: patchVersion, revision_id: branchB },
    parents: [acceptedDecision.event_id]
  });
  const editedVersion = entity("patch-version", "b");
  await fixture.addEvent({
    device: fixture.device("g"),
    semanticKind: "patch_operation",
    data: { operation: "edit", document_id: documentId, patch_id: patchId, patch_version_id: editedVersion, revision_id: branchB },
    parents: [propose.event_id]
  });

  const reviewId = entity("review-batch", "a");
  const reviewCreate = await fixture.addEvent({
    device: fixture.device("h"),
    semanticKind: "review_batch_operation",
    data: { operation: "create", review_batch_id: reviewId },
    parents: [eventId]
  });
  await fixture.addEvent({
    device: fixture.device("i"),
    semanticKind: "review_batch_operation",
    data: { operation: "respond", review_batch_id: reviewId, response_hash: "a".repeat(64), contribution_payload_ids: [] },
    parents: [reviewCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("q"),
    semanticKind: "review_batch_operation",
    data: {
      operation: "respond",
      review_batch_id: reviewId,
      response_hash: "b".repeat(64),
      contribution_payload_ids: [propose.core.semantic_payload_id]
    },
    parents: [reviewCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("r"),
    semanticKind: "review_batch_operation",
    data: { operation: "respond", review_batch_id: reviewId, response_hash: "a".repeat(64), contribution_payload_ids: [] },
    parents: [reviewCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("j"),
    semanticKind: "review_batch_operation",
    data: { operation: "cancel", review_batch_id: reviewId },
    parents: [reviewCreate.event_id]
  });
  const secondReviewId = entity("review-batch", "b");
  await fixture.addEvent({
    device: fixture.device("s"),
    semanticKind: "review_batch_operation",
    data: { operation: "create", review_batch_id: secondReviewId },
    parents: [eventId]
  });

  const rewriteId = entity("rewrite-session", "a");
  const rewriteCreate = await fixture.addEvent({
    device: fixture.device("k"),
    semanticKind: "rewrite_operation",
    data: { operation: "create", document_id: documentId, rewrite_session_id: rewriteId },
    parents: [eventId]
  });
  await fixture.addEvent({
    device: fixture.device("l"),
    semanticKind: "rewrite_operation",
    data: { operation: "apply", document_id: documentId, rewrite_session_id: rewriteId, revision_id: branchB },
    parents: [rewriteCreate.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("t"),
    semanticKind: "rewrite_operation",
    data: { operation: "create", document_id: documentId, rewrite_session_id: entity("rewrite-session", "b") },
    parents: [eventId]
  });
  await fixture.addEvent({
    device: fixture.device("u"),
    semanticKind: "patch_operation",
    data: {
      operation: "propose",
      document_id: documentId,
      patch_id: entity("patch", "b"),
      patch_version_id: entity("patch-version", "c")
    },
    parents: [eventId]
  });
  await fixture.addEvent({
    device: fixture.device("m"),
    semanticKind: "rewrite_operation",
    data: { operation: "discard", document_id: documentId, rewrite_session_id: rewriteId },
    parents: [rewriteCreate.event_id]
  });
  const mergeAuthorization = {
    schema_version: 1,
    object_kind: "merge_authorization",
    authorization_mode: "explicit_editor",
    merge_key_id: digest("merge-key", "b"),
    authorizing_device_id: fixture.device("n"),
    authorizing_role: "editor"
  };
  const mergeOne = await fixture.addEvent({
    device: fixture.device("n"),
    semanticKind: "merge_revision_adoption",
    data: { document_id: documentId, revision_id: mergeRevision, authorization: mergeAuthorization },
    parents: [adoptA.event_id, adoptB.event_id]
  });
  await fixture.addEvent({
    device: fixture.device("o"),
    semanticKind: "merge_revision_adoption",
    data: {
      document_id: documentId,
      revision_id: mergeRevision,
      authorization: {
        ...mergeAuthorization,
        authorizing_device_id: fixture.device("o")
      }
    },
    parents: [adoptA.event_id, adoptB.event_id]
  });
  const projection = (await projectCollaborationHistory(fixture.input())).projection;
  const patch = projection.documents[0].patches[0];
  check(patch.versions.find((entry) => entry.patch_version_id === patchVersion).decision.state, "conflicted");
  check(patch.versions.find((entry) => entry.patch_version_id === editedVersion).decision.state, "unset");
  check(projection.review_batches[0].lifecycle.state, "conflicted");
  check(projection.review_batches.length, 2, "concurrent review-batch creation must be a union");
  check(projection.review_batches[0].responses.state, "conflicted");
  check(
    projection.review_batches[0].responses.contenders.find((entry) => entry.value === "a".repeat(64)).event_ids.length,
    2,
    "identical response hashes must deduplicate with provenance"
  );
  ok(projection.review_batches[0].contribution_payload_ids.includes(propose.core.semantic_payload_id));
  check(projection.documents[0].patches.length, 2, "concurrent logical patch proposals must be a union");
  check(projection.rewrite_sessions[0].outcome.state, "conflicted");
  check(projection.rewrite_sessions.length, 2, "distinct rewrite sessions must be a union");
  ok(projection.reduction_rejections.some((entry) => entry.reason === "invalid_transition"));
  check(projection.revision_heads[0].head_revision_ids, [mergeRevision]);
  const mergeAdoption = projection.revision_heads[0].adoptions.find((entry) => entry.revision_id === mergeRevision);
  check(mergeAdoption.adopting_event_ids.length, 2, "duplicate merge authorizations must reduce to one adoption");
  ok(mergeAdoption.adopting_event_ids.includes(mergeOne.event_id));
}

async function testRevisionAdoptionRejections() {
  const fixture = new ProjectionFixture();
  const { eventId, documentId, revisionId } = await fixture.initialize();
  const reviewerRevision = await fixture.addRevision(documentId, "# Reviewer proposal\n", [revisionId]);
  await fixture.addEvent({
    device: fixture.device("b", "reviewer"),
    semanticKind: "revision_adoption",
    data: { document_id: documentId, revision_id: reviewerRevision },
    parents: [eventId]
  });
  const projection = (await projectCollaborationHistory(fixture.input())).projection;
  check(projection.revision_heads[0].head_revision_ids, [revisionId]);
  ok(projection.reduction_rejections.some((entry) => entry.reason === "unauthorized_revision_adoption"));

  const mismatched = new ProjectionFixture();
  const initialized = await mismatched.initialize();
  const foreignDocument = entity("document", "z");
  const wrongRevision = await mismatched.addRevision(foreignDocument, "# Wrong document\n", [], "genesis");
  await mismatched.addEvent({
    device: mismatched.device("b", "editor"),
    semanticKind: "revision_adoption",
    data: { document_id: initialized.documentId, revision_id: wrongRevision },
    parents: [initialized.eventId]
  });
  await assert.rejects(
    () => projectCollaborationHistory(mismatched.input()),
    /wrong document/
  );
  assertions += 1;

  const deleted = new ProjectionFixture();
  const deletedBase = await deleted.initialize();
  const deletedBranch = await deleted.addRevision(
    deletedBase.documentId,
    "# Preserved deleted-document branch\n",
    [deletedBase.revisionId]
  );
  await deleted.addEvent({
    device: deleted.device("b", "editor"),
    semanticKind: "revision_adoption",
    data: { document_id: deletedBase.documentId, revision_id: deletedBranch },
    parents: [deletedBase.eventId]
  });
  await deleted.addEvent({
    device: deleted.device("c", "editor"),
    semanticKind: "metadata_operation",
    data: { operation: "document_delete", document_id: deletedBase.documentId },
    parents: [deletedBase.eventId]
  });
  const deletedProjection = (await projectCollaborationHistory(deleted.input())).projection;
  ok(deletedProjection.documents[0].tombstone, "document deletion must remain projected");
  check(
    deletedProjection.revision_heads[0].head_revision_ids,
    [deletedBranch],
    "document deletion must preserve adopted revision branches"
  );

  const local = new ProjectionFixture();
  const localBase = await local.initialize();
  const foreign = new ProjectionFixture();
  foreign.project = entity("project", "b");
  const foreignBase = await foreign.initialize("# Foreign project\n");
  local.revisions.set(
    foreignBase.revisionId,
    foreign.revisions.get(foreignBase.revisionId)
  );
  await local.addEvent({
    device: local.device("b", "editor"),
    semanticKind: "revision_adoption",
    data: {
      document_id: localBase.documentId,
      revision_id: foreignBase.revisionId
    },
    parents: [localBase.eventId]
  });
  await assert.rejects(
    () => projectCollaborationHistory(local.input()),
    /wrong project or document/
  );
  assertions += 1;
}

async function testMergeCandidatesAndAuthority() {
  const sharedVector = await evaluateCollaborationMergeVector();
  ok(sharedVector.result_bytes_hex.length > 0, "shared Node/browser merge vector must produce exact bytes");
  const fixture = new ProjectionFixture();
  const documentId = entity("document", "a");
  const baseText = "\ufeff# A\r\n\r\nalpha café\r\n\r\n# B\r\n\r\nbeta\r\n";
  const base = await fixture.addRevision(documentId, baseText, [], "genesis");
  const left = await fixture.addRevision(documentId, baseText.replace("alpha café", "alpha revised café"), [base]);
  const right = await fixture.addRevision(documentId, baseText.replace("beta", "beta revised"), [base]);
  const third = await fixture.addRevision(documentId, baseText.replace("# A", "# A updated"), [base]);
  const input = mergeInput(fixture, documentId, base, [right, left]);
  const merged = await calculateMarkdownMergeCandidate(input);
  check(merged.status, "candidate");
  check(merged.classification, "proven_safe");
  check(
    [...merged.exact_markdown_bytes],
    [...encoder.encode(baseText.replace("alpha café", "alpha revised café").replace("beta", "beta revised"))]
  );
  check(new TextDecoder().decode(merged.exact_markdown_bytes).startsWith("#"), true, "default decoder hides the preserved BOM");
  ok(!new TextDecoder().decode(merged.exact_markdown_bytes).includes("<<<<<<<"));
  const repeated = await calculateMarkdownMergeCandidate({ ...input, parent_revision_ids: [left, right] });
  check(repeated.status, "candidate");
  check(repeated.revision_id, merged.revision_id);
  check(repeated.merge_key_id, merged.merge_key_id);
  check(
    fixture.revisions.has(merged.revision_id),
    false,
    "calculating a candidate must not store or adopt its result revision"
  );
  const changedAlgorithmKey = await deriveMergeKeyIdentity({
    ...merged.candidate.merge_key_core,
    merge_algorithm_version: "v2"
  });
  ok(
    changedAlgorithmKey.id !== merged.merge_key_id,
    "algorithm version must separate merge-key identity"
  );

  const multi = await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, base, [third, right, left]));
  check(multi.status, "candidate", "pairwise independent multi-head edits must merge");

  const overlapOne = await fixture.addRevision(documentId, baseText.replace("alpha café", "one"), [base]);
  const overlapTwo = await fixture.addRevision(documentId, baseText.replace("alpha café", "two"), [base]);
  const overlap = await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, base, [overlapOne, overlapTwo]));
  check(overlap.status, "conflict");
  const insertOne = await fixture.addRevision(documentId, baseText.replace("# B", "insert one\r\n# B"), [base]);
  const insertTwo = await fixture.addRevision(documentId, baseText.replace("# B", "insert two\r\n# B"), [base]);
  check((await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, base, [insertOne, insertTwo]))).status, "conflict");
  const deleted = await fixture.addRevision(documentId, baseText.replace("alpha café\r\n", ""), [base]);
  check((await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, base, [deleted, overlapOne]))).status, "conflict");
  check((await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, null, [left, right]))).status, "unsupported");
  check((await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, base, [base, left]))).status, "not_required");
  const identicalA = await fixture.addRevision(documentId, "same\n", [base]);
  const identicalB = await fixture.addRevision(documentId, "same\n", [base, left]);
  const identical = await calculateMarkdownMergeCandidate(mergeInput(fixture, documentId, base, [identicalA, identicalB]));
  check(identical.status, "candidate");
  check(identical.classification, "identical");
  check((await calculateMarkdownMergeCandidate({
    ...input,
    merge_algorithm_version: "v2"
  })).status, "unsupported");
  const corruptedMerge = await calculateMarkdownMergeCandidate({
    ...input,
    read_blob: async () => ({ status: "corrupted", reason: "fixture corruption" })
  });
  check(corruptedMerge.status, "invalid", "corrupted merge dependencies must fail closed");

  const moveBase = await fixture.addRevision(documentId, "# A\nalpha\n# B\nbeta\n# C\n", [], "genesis");
  const movedSection = await fixture.addRevision(documentId, "# B\nbeta\n# C\n# A\nalpha\n", [moveBase]);
  const editedSection = await fixture.addRevision(documentId, "# A\nalpha edited\n# B\nbeta\n# C\n", [moveBase]);
  const moveWithoutProvenance = await calculateMarkdownMergeCandidate(
    mergeInput(fixture, documentId, moveBase, [movedSection, editedSection])
  );
  check(moveWithoutProvenance.status, "conflict");
  const moveWithProvenance = await calculateMarkdownMergeCandidate({
    ...mergeInput(fixture, documentId, moveBase, [editedSection, movedSection]),
    section_move_provenance: [{
      provenance_version: 1,
      moving_revision_id: movedSection,
      editing_revision_id: editedSection,
      source_start_line: 0,
      source_end_line: 2,
      target_line: 5,
      uniqueness: "unique_verified_section"
    }]
  });
  check(moveWithProvenance.status, "candidate");
  check(moveWithProvenance.evidence.classification, "unique_section_move_and_edit");
  check(new TextDecoder().decode(moveWithProvenance.exact_markdown_bytes), "# B\nbeta\n# C\n# A\nalpha edited\n");

  const authorities = ["a", "b", "c"].map((marker, index) => ({
    device_id: entity("device", marker),
    person_id: entity("person", marker),
    signing_key_id: entity("public-key", marker),
    role: index === 2 ? "reviewer" : index === 0 ? "owner" : "editor",
    capabilities: capabilitiesForRole(index === 2 ? "reviewer" : index === 0 ? "owner" : "editor"),
    status: "active",
    maximum_accepted_semantic_sequence: null
  }));
  const eligibility = await deriveMergeAuthorizationEligibility({
    merge_key_id: merged.merge_key_id,
    outcome: "proven_safe",
    policy: "auto_safe",
    policy_control_head_id: fixture.controlHead,
    device_authorities: authorities,
    online_device_ids: [],
    accepted_attempts: []
  });
  check(eligibility.manual_authorizer_device_ids.length, 2);
  ok(eligibility.automatic_proposer_device_id !== authorities[2].device_id, "reviewer cannot authorize");
  check(eligibility.automatic_proposer_online, false);
  const repeatedElection = await deriveMergeAuthorizationEligibility({
    merge_key_id: merged.merge_key_id,
    outcome: "proven_safe",
    policy: "auto_safe",
    policy_control_head_id: fixture.controlHead,
    device_authorities: [...authorities].reverse(),
    online_device_ids: [authorities[1].device_id],
    accepted_attempts: []
  });
  check(repeatedElection.automatic_proposer_device_id, eligibility.automatic_proposer_device_id, "availability must not re-elect proposer");
  const unresolvedEligibility = await deriveMergeAuthorizationEligibility({
    merge_key_id: merged.merge_key_id,
    outcome: "requires_resolution",
    policy: "auto_safe",
    policy_control_head_id: fixture.controlHead,
    device_authorities: authorities,
    online_device_ids: authorities.map((entry) => entry.device_id),
    accepted_attempts: []
  });
  check(
    unresolvedEligibility.automatic_proposer_device_id,
    null,
    "auto_safe must not elect a proposer for unresolved candidates"
  );
  const attempted = await deriveMergeAuthorizationEligibility({
    merge_key_id: merged.merge_key_id,
    outcome: "proven_safe",
    policy: "auto_safe",
    policy_control_head_id: fixture.controlHead,
    device_authorities: authorities,
    online_device_ids: [],
    accepted_attempts: [{
      event_id: digest("semantic-event", "z"),
      merge_key_id: merged.merge_key_id,
      author_device_id: eligibility.automatic_proposer_device_id
    }]
  });
  check(attempted.automatic_attempt_available, false);
  const manual = await deriveMergeAuthorizationEligibility({
    merge_key_id: merged.merge_key_id,
    outcome: "proven_safe",
    policy: "manual",
    policy_control_head_id: fixture.controlHead,
    device_authorities: authorities,
    online_device_ids: [],
    accepted_attempts: []
  });
  check(manual.automatic_proposer_device_id, null);
}

async function testFailClosedDependencies() {
  const fixture = new ProjectionFixture();
  await fixture.initialize();
  const missingEventInput = fixture.input();
  const missingId = fixture.accepted[0];
  missingEventInput.read_event = async (id) => id === missingId
    ? { status: "corrupted", reason: "fixture corruption" }
    : validOrMissing(fixture.events.get(id), "missing");
  await assert.rejects(() => projectCollaborationHistory(missingEventInput), /corrupted/);
  assertions += 1;
  const absentEventInput = fixture.input();
  absentEventInput.read_event = async (id) => id === missingId
    ? { status: "missing", reason: "fixture omission" }
    : validOrMissing(fixture.events.get(id), "missing");
  await assert.rejects(() => projectCollaborationHistory(absentEventInput), /missing/);
  assertions += 1;
  const wrongFrontier = fixture.input();
  wrongFrontier.accepted_semantic_frontier = [digest("semantic-event", "y")];
  await assert.rejects(() => projectCollaborationHistory(wrongFrontier), /frontier/);
  assertions += 1;
  assert.throws(() => parseSemanticPayloadCore({
    schema_version: 99,
    project_id: fixture.project,
    semantic_kind: "metadata_operation",
    data: { operation: "project_title", value: "x" }
  }), /version/);
  assertions += 1;
  assert.throws(() => parseSemanticPayloadCore({
    schema_version: 1,
    project_id: fixture.project,
    semantic_kind: "external_markdown_import_candidate",
    data: {}
  }), /unsupported/);
  assertions += 1;
}

async function concurrentMetadata(fixture, parent, operation, ids, value, marker) {
  return fixture.addEvent({
    device: fixture.device(marker),
    semanticKind: "metadata_operation",
    data: {
      operation,
      ...ids,
      ...(value === undefined ? {} : { value })
    },
    parents: [parent]
  });
}

function mergeInput(fixture, documentId, baseRevisionId, parents) {
  return {
    project_id: fixture.project,
    document_id: documentId,
    base_revision_id: baseRevisionId,
    parent_revision_ids: parents,
    merge_algorithm_id: INITIAL_MERGE_ALGORITHM_ID,
    merge_algorithm_version: INITIAL_MERGE_ALGORITHM_VERSION,
    async read_revision(id) {
      return validOrMissing(fixture.revisions.get(id), "revision missing");
    },
    async read_blob(projectId, id) {
      if (projectId !== fixture.project) return { status: "mismatched", reason: "project" };
      return validOrMissing(fixture.blobs.get(id), "blob missing");
    }
  };
}

function deterministicPermutations(values, count) {
  let seed = 0x51ce5eed;
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const copy = [...values];
    for (let position = copy.length - 1; position > 0; position -= 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const target = seed % (position + 1);
      [copy[position], copy[target]] = [copy[target], copy[position]];
    }
    output.push(copy);
  }
  return output;
}

function stableProjection(projection) {
  return JSON.stringify(projection);
}

function validOrMissing(value, reason) {
  return value === undefined
    ? { status: "missing", reason }
    : { status: "valid", value };
}

function writeTrap() {
  throw new Error("Projector attempted to acquire write authority.");
}

function entity(kind, marker = "a") {
  const safeMarker = markers.includes(marker) ? marker : "a";
  return `pm:${kind}:v1:${"a".repeat(24)}${safeMarker}a`;
}

function digest(kind, marker = "a") {
  const safeMarker = markers.includes(marker) ? marker : "a";
  return `pm:${kind}:v1:${"a".repeat(50)}${safeMarker}a`;
}

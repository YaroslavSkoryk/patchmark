import {
  capabilitiesForRole,
  type CollaborationCapability,
  type CollaborationRole
} from "./capabilities.ts";
import type { AttestationRecord } from "./checkpoints.ts";
import {
  parseControlEventRecord,
  parseDerivedControlForkRecord,
  type ControlActionRecord,
  type ControlEventRecord,
  type DerivedControlForkRecord
} from "./control.ts";
import { digestBytesFromId } from "./digest-ids.ts";
import {
  deriveControlForkConflictId
} from "./event-control-indexes.ts";
import type {
  AttestationIndexEntry,
  AttestationVerificationRequest,
  ClassificationDisposition,
  ClassificationReason,
  CollaborationAttestationVerifier,
  CollaborationControlTransitionVerifier,
  ControlAuthorityState,
  ControlEventClassification,
  ControlTransitionVerificationRequest,
  DeviceAuthorityFact,
  EventControlProjectState,
  RootControlForkRecord,
  SemanticDeviceForkRecord,
  SemanticEventClassification,
  SemanticSequenceReservation
} from "./event-control-types.ts";
import {
  parseDigestId,
  parseEntityId,
  type AttestationId,
  type ControlEventId,
  type DeviceId,
  type ProjectId,
  type PublicKeyId,
  type SemanticEventId
} from "./identities.ts";
import { ImmutableCollaborationStore } from "./immutable-store.ts";
import {
  buildSignaturePreimage
} from "./preimages.ts";
import {
  parseSemanticEventRecord,
  type SemanticEventRecord,
  type SemanticPayloadRecord
} from "./semantic.ts";
import {
  verifyReviewResponseEvidenceCommitment
} from "./review-response-evidence.ts";
import { encodeCanonicalCbor } from "./canonical-cbor.ts";
import {
  expectUInt64,
  type UInt64
} from "./validation.ts";

export type ReconstructedEventControlProject = Readonly<{
  state: EventControlProjectState;
  control_authorities: ReadonlyMap<ControlEventId, ControlAuthorityState>;
}>;

export type EventControlReconstructionInput = Readonly<{
  project_id: ProjectId;
  payloads: ReadonlyMap<string, SemanticPayloadRecord>;
  actions: ReadonlyMap<string, ControlActionRecord>;
  semantic_events: ReadonlyMap<string, SemanticEventRecord>;
  control_events: ReadonlyMap<string, ControlEventRecord>;
  attestations: ReadonlyMap<string, AttestationRecord>;
  invalid_object_ids: readonly string[];
  pending_reservations: readonly SemanticSequenceReservation[];
  revision_store: ImmutableCollaborationStore;
  attestation_verifier: CollaborationAttestationVerifier;
  transition_verifier: CollaborationControlTransitionVerifier;
}>;

type ControlRebuild = Readonly<{
  classifications: ReadonlyMap<ControlEventId, ControlEventClassification>;
  accepted_ids: readonly ControlEventId[];
  authorities: ReadonlyMap<ControlEventId, ControlAuthorityState>;
  forks: readonly DerivedControlForkRecord[];
  root_forks: readonly RootControlForkRecord[];
  superseded_ids: readonly ControlEventId[];
  control_frozen: boolean;
  root_frozen: boolean;
}>;

type ControlValidationResult =
  | Readonly<{ ok: true; authority: ControlAuthorityState }>
  | Readonly<{
      ok: false;
      disposition: ClassificationDisposition;
      reason: ClassificationReason;
      detail: string;
    }>;

type SemanticBaseResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      disposition: ClassificationDisposition;
      reason: ClassificationReason;
      detail: string;
    }>;

type ValidationGate =
  | Readonly<{ ok: true }>
  | Exclude<SemanticBaseResult, Readonly<{ ok: true }>>;

export async function reconstructEventControlProject(
  input: EventControlReconstructionInput
): Promise<ReconstructedEventControlProject> {
  const project = parseEntityId("project", input.project_id);
  const controls = await reconstructControls(project, input);
  const semantics = await reconstructSemantics(project, input, controls);
  const state: EventControlProjectState = Object.freeze({
    schema_version: 1,
    object_kind: "event_control_project_state",
    project_id: project,
    semantic_classifications: Object.freeze(
      [...semantics.classifications.values()].sort(byObjectId)
    ),
    control_classifications: Object.freeze(
      [...controls.classifications.values()].sort(byObjectId)
    ),
    accepted_semantic_event_ids: semantics.accepted_ids,
    accepted_control_event_ids: controls.accepted_ids,
    accepted_semantic_frontier: semantics.frontier,
    semantic_forks: semantics.forks,
    control_forks: controls.forks,
    root_forks: controls.root_forks,
    superseded_control_event_ids: controls.superseded_ids,
    attestation_index: buildAttestationIndex(project, input.attestations),
    pending_reservations: Object.freeze(
      input.pending_reservations
        .filter((entry) => entry.project_id === project && entry.reservation_state === "pending")
        .sort((left, right) => left.device_id < right.device_id ? -1 : 1)
    ),
    invalid_object_ids: frozenSortedUnique(input.invalid_object_ids)
  });
  return Object.freeze({ state, control_authorities: controls.authorities });
}

async function reconstructControls(
  project: ProjectId,
  input: EventControlReconstructionInput
): Promise<ControlRebuild> {
  const records = [...input.control_events.values()]
    .filter((record) => record.core.project_id === project)
    .sort((left, right) => left.control_event_id < right.control_event_id ? -1 : 1);
  const byId = new Map(records.map((record) => [record.control_event_id, record]));
  const provisional = new Set<ControlEventId>();
  const authorities = new Map<ControlEventId, ControlAuthorityState>();
  const classifications = new Map<ControlEventId, ControlEventClassification>();
  const terminal = new Set<ControlEventId>();

  const genesisRecords = records.filter((record) => record.core.control_kind === "genesis");
  for (const record of genesisRecords) {
    const result = await validateControlRecord(
      project,
      record,
      null,
      null,
      input
    );
    if (result.ok) {
      provisional.add(record.control_event_id);
      authorities.set(record.control_event_id, result.authority);
    } else {
      classifications.set(
        record.control_event_id,
        controlClassification(project, record.control_event_id, result)
      );
      terminal.add(record.control_event_id);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      const id = record.control_event_id;
      if (record.core.control_kind === "genesis" || provisional.has(id) || terminal.has(id)) {
        continue;
      }
      const previousId = record.core.previous_control_id;
      const previousRecord = byId.get(previousId);
      if (!previousRecord) continue;
      if (!provisional.has(previousId)) continue;
      let previousRoot: ControlEventRecord | null = null;
      if (record.core.control_kind === "root_recovery") {
        previousRoot = byId.get(record.core.previous_root_control_id) ?? null;
        if (!previousRoot || !provisional.has(previousRoot.control_event_id)) continue;
        if (previousRoot.core.control_kind === "ordinary") continue;
      }
      const result = await validateControlRecord(
        project,
        record,
        previousRecord,
        previousRoot,
        input,
        authorities.get(previousId)
      );
      if (result.ok) {
        provisional.add(id);
        authorities.set(id, result.authority);
      } else {
        classifications.set(id, controlClassification(project, id, result));
        terminal.add(id);
      }
      changed = true;
    }
  }

  for (const record of records) {
    if (provisional.has(record.control_event_id) || terminal.has(record.control_event_id)) {
      continue;
    }
    const parent = record.core.previous_control_id;
    const hasParent = parent !== null && byId.has(parent);
    classifications.set(
      record.control_event_id,
      controlClassification(project, record.control_event_id, {
        disposition: "pending",
        reason: hasParent ? "control_state_unavailable" : "missing_control_head",
        detail: hasParent
          ? "The previous control event is not currently accepted."
          : "The previous control event has not arrived."
      })
    );
  }

  const rootForks = rootForkRecords(project, records, provisional);
  const rootFrozen = rootForks.length > 0;
  const superseded = new Set<ControlEventId>();
  if (!rootFrozen) {
    for (const recovery of records.filter(
      (record) => record.core.control_kind === "root_recovery" && provisional.has(record.control_event_id)
    )) {
      if (recovery.core.control_kind !== "root_recovery") continue;
      for (const candidate of records) {
        if (!provisional.has(candidate.control_event_id)) continue;
        const firstChild = firstChildAfter(
          recovery.core.previous_control_id,
          candidate.control_event_id,
          byId
        );
        if (firstChild && firstChild !== recovery.control_event_id) {
          superseded.add(candidate.control_event_id);
        }
      }
    }
  }

  const controlForks: DerivedControlForkRecord[] = [];
  const disputed = new Set<ControlEventId>();
  if (!rootFrozen) {
    const children = new Map<ControlEventId, ControlEventId[]>();
    for (const record of records) {
      if (
        record.core.control_kind !== "ordinary" ||
        !provisional.has(record.control_event_id) ||
        superseded.has(record.control_event_id)
      ) continue;
      const list = children.get(record.core.previous_control_id) ?? [];
      list.push(record.control_event_id);
      children.set(record.core.previous_control_id, list);
    }
    for (const [previousId, contenderValues] of children) {
      const contenders = frozenSortedUnique(contenderValues);
      if (contenders.length < 2) continue;
      const conflictId = await deriveControlForkConflictId(project, previousId, contenders);
      controlForks.push(parseDerivedControlForkRecord({
        schema_version: 1,
        object_kind: "derived_control_fork",
        authority: "none",
        quarantine_state: "control_projection_frozen",
        conflict_id: conflictId,
        project_id: project,
        last_uncontested_control_id: previousId,
        conflicting_tip_ids: contenders
      }));
      for (const candidate of records) {
        if (
          contenders.some((contender) =>
            candidate.control_event_id === contender ||
            isDescendantOf(contender, candidate.control_event_id, byId)
          )
        ) disputed.add(candidate.control_event_id);
      }
    }
  }

  if (rootFrozen) {
    for (const id of provisional) {
      classifications.set(
        id,
        controlClassification(project, id, {
          disposition: "authority_conflict",
          reason: "root_fork",
          detail: "Root-authorized control history is forked and the protocol is frozen."
        })
      );
    }
  } else {
    for (const id of provisional) {
      if (superseded.has(id)) {
        classifications.set(
          id,
          controlClassification(project, id, {
            disposition: "authority_conflict",
            reason: "superseded_control_branch",
            detail: "A root recovery superseded this nonselected control branch."
          })
        );
      } else if (disputed.has(id)) {
        classifications.set(
          id,
          controlClassification(project, id, {
            disposition: "authority_conflict",
            reason: "control_fork",
            detail: "This control event belongs to an unresolved active-device fork."
          })
        );
      } else {
        classifications.set(
          id,
          controlClassification(project, id, {
            disposition: "accepted",
            reason: "accepted",
            detail: "Control event passed structural, transition, and attestation validation."
          })
        );
      }
    }
  }

  const accepted = [...provisional].filter(
    (id) => !rootFrozen && !superseded.has(id) && !disputed.has(id)
  ).sort();
  const acceptedSet = new Set(accepted);
  const acceptedAuthorities = new Map(
    [...authorities].filter(([id]) => acceptedSet.has(id))
  );
  return Object.freeze({
    classifications,
    accepted_ids: Object.freeze(accepted),
    authorities: acceptedAuthorities,
    forks: Object.freeze(controlForks.sort((a, b) => a.conflict_id < b.conflict_id ? -1 : 1)),
    root_forks: Object.freeze(rootForks),
    superseded_ids: Object.freeze([...superseded].sort()),
    control_frozen: controlForks.length > 0,
    root_frozen: rootFrozen
  });
}

async function validateControlRecord(
  project: ProjectId,
  record: ControlEventRecord,
  previous: ControlEventRecord | null,
  previousRoot: ControlEventRecord | null,
  input: EventControlReconstructionInput,
  previousAuthority?: ControlAuthorityState
): Promise<ControlValidationResult> {
  try {
    if (record.core.project_id !== project) {
      return invalid("cross_project_reference", "Control event belongs to another project.");
    }
    if (record.core.control_kind === "genesis") {
      parseControlEventRecord(record);
      const expected = genesisAuthority(record);
      const request = transitionRequest(record, null, null);
      const transition = await verifyTransition(request, input.transition_verifier);
      if (!transition.ok) return transition;
      if (!sameAuthority(expected, transition.authority)) {
        return invalid(
          "invalid_previous_link",
          "Genesis transition authority does not exactly match its pinned memberships and devices."
        );
      }
      const attestation = await verifySingleAttestation(
        record.authority_attestation_id,
        input.attestations,
        input.attestation_verifier,
        {
          project_id: project,
          subject_kind: "control_event",
          subject_id: record.control_event_id,
          expected_key_id: record.core.offline_root_key_id,
          referenced_control_head_id: null,
          root_authority_context_id: null,
          expected_device_id: null,
          expected_person_id: record.core.owner_person_id
        }
      );
      if (!attestation.ok) return attestation;
      return Object.freeze({ ok: true, authority: transition.authority });
    }

    if (!previous || !previousAuthority) {
      return pending("missing_control_head", "Previous control event is unavailable.");
    }
    if (previous.core.project_id !== project) {
      return invalid("cross_project_reference", "Previous control event belongs to another project.");
    }
    const expectedSequence = nextUInt64(previous.core.control_sequence, "control sequence");
    if (record.core.control_sequence !== expectedSequence) {
      return invalid(
        record.core.control_sequence < expectedSequence
          ? "sequence_regression"
          : "invalid_previous_link",
        "Control sequence must increment its exact previous control event."
      );
    }
    const action = input.actions.get(record.core.action_id);
    if (!action) return pending("missing_action", "Referenced control action has not arrived.");
    if (action.core.project_id !== project) {
      return invalid("cross_project_reference", "Control action belongs to another project.");
    }

    if (record.core.control_kind === "ordinary") {
      const ordinaryCore = record.core;
      if (ordinaryCore.issuer_device_id !== previousAuthority.active_control_device_id) {
        return conflict(
          "non_designated_control_issuer",
          "Ordinary control event was not issued by the designated active control device."
        );
      }
      parseControlEventRecord(record, {
        action,
        ordinary_context: {
          expected_previous_control_id: previous.control_event_id,
          expected_control_sequence: expectedSequence,
          designated_active_control_device_id: previousAuthority.active_control_device_id,
          expected_project_id: project
        }
      });
      const issuer = previousAuthority.device_authorities.find(
        (fact) => fact.device_id === ordinaryCore.issuer_device_id
      );
      if (!issuer || issuer.status !== "active") {
        return conflict("unauthorized_device", "Control issuer is not currently authorized.");
      }
      const request = transitionRequest(record, previousAuthority, action);
      const transition = await verifyTransition(request, input.transition_verifier);
      if (!transition.ok) return transition;
      const attestation = await verifySingleAttestation(
        record.authority_attestation_id,
        input.attestations,
        input.attestation_verifier,
        {
          project_id: project,
          subject_kind: "control_event",
          subject_id: record.control_event_id,
          expected_key_id: issuer.signing_key_id,
          referenced_control_head_id: previous.control_event_id,
          root_authority_context_id: null,
          expected_device_id: issuer.device_id,
          expected_person_id: issuer.person_id
        }
      );
      if (!attestation.ok) return attestation;
      return Object.freeze({ ok: true, authority: transition.authority });
    }

    if (!previousRoot || previousRoot.core.control_kind === "ordinary") {
      return pending("control_state_unavailable", "Previous root control event is unavailable.");
    }
    const previousRootSequence = previousRoot.core.root_sequence;
    if (record.core.root_sequence !== nextUInt64(previousRootSequence, "root sequence")) {
      return invalid("invalid_previous_link", "Root sequence must be strictly linear.");
    }
    parseControlEventRecord(record, { action });
    if (record.core.issuer_root_key_id !== previousAuthority.offline_root_key_id) {
      return conflict("unauthorized_device", "Root recovery uses an unpinned root key.");
    }
    if (action.core.action_kind === "root_recovery") {
      const projectControls = new Map(
        [...input.control_events.values()]
          .filter((candidate) => candidate.core.project_id === project)
          .map((candidate) => [candidate.control_event_id, candidate])
      );
      for (const tipId of action.core.observed_conflicting_tip_ids) {
        const tip = input.control_events.get(tipId);
        if (!tip) {
          return pending(
            "control_state_unavailable",
            `Observed conflicting control tip ${tipId} has not arrived.`
          );
        }
        if (tip.core.project_id !== project) {
          return invalid(
            "cross_project_reference",
            "Observed conflicting control tip belongs to another project."
          );
        }
        if (!isDescendantOf(record.core.previous_control_id, tipId, projectControls)) {
          return invalid(
            "invalid_previous_link",
            "Observed conflicting control tip is not a descendant of the recovery base."
          );
        }
      }
    }
    const request = transitionRequest(record, previousAuthority, action);
    const transition = await verifyTransition(request, input.transition_verifier);
    if (!transition.ok) return transition;
    if (
      action.core.action_kind !== "root_recovery" ||
      transition.authority.active_control_device_id !==
        action.core.replacement_active_control_device_id ||
      transition.authority.key_epoch_id !== action.core.replacement_key_epoch_id ||
      transition.authority.key_epoch_commitment !==
        action.core.replacement_key_epoch_commitment
    ) {
      return invalid(
        "invalid_previous_link",
        "Root recovery transition does not match its selected replacement authority."
      );
    }
    for (const cutoff of action.core.revocation_sequence_cutoffs) {
      const fact = transition.authority.device_authorities.find(
        (candidate) => candidate.device_id === cutoff.device_id
      );
      if (
        !fact ||
        fact.status !== "revoked" ||
        fact.maximum_accepted_semantic_sequence !==
          cutoff.maximum_accepted_semantic_sequence
      ) {
        return invalid(
          "invalid_previous_link",
          "Root recovery transition does not apply its exact revocation cutoff facts."
        );
      }
    }
    const attestation = await verifySingleAttestation(
      record.authority_attestation_id,
      input.attestations,
      input.attestation_verifier,
      {
        project_id: project,
        subject_kind: "control_event",
        subject_id: record.control_event_id,
        expected_key_id: record.core.issuer_root_key_id,
        referenced_control_head_id: record.core.previous_control_id,
        root_authority_context_id: record.core.previous_root_control_id,
        expected_device_id: null,
        expected_person_id: null
      }
    );
    if (!attestation.ok) return attestation;
    return Object.freeze({ ok: true, authority: transition.authority });
  } catch (error) {
    return invalid("malformed_encoding", errorMessage(error));
  }
}

async function reconstructSemantics(
  project: ProjectId,
  input: EventControlReconstructionInput,
  controls: ControlRebuild
): Promise<Readonly<{
  classifications: ReadonlyMap<SemanticEventId, SemanticEventClassification>;
  accepted_ids: readonly SemanticEventId[];
  frontier: readonly SemanticEventId[];
  forks: readonly SemanticDeviceForkRecord[];
}>> {
  const records = [...input.semantic_events.values()]
    .filter((record) => record.core.project_id === project)
    .sort((left, right) => left.event_id < right.event_id ? -1 : 1);
  const byId = new Map(records.map((record) => [record.event_id, record]));
  const baseValid = new Set<SemanticEventId>();
  const classifications = new Map<SemanticEventId, SemanticEventClassification>();

  for (const record of records) {
    let result: SemanticBaseResult;
    if (controls.root_frozen) {
      result = conflict("root_fork", "Root control history is forked.");
    } else if (controls.control_frozen) {
      result = conflict("control_fork", "Control authority is frozen by an unresolved fork.");
    } else {
      result = await validateSemanticBase(project, record, byId, input, controls);
    }
    if (result.ok) baseValid.add(record.event_id);
    else {
      classifications.set(
        record.event_id,
        semanticClassification(project, record.event_id, result)
      );
    }
  }

  const forked = new Set<SemanticEventId>();
  const forks: SemanticDeviceForkRecord[] = [];
  const forkGroups = new Map<string, SemanticEventRecord[]>();
  for (const record of records) {
    if (!baseValid.has(record.event_id)) continue;
    const key = `${record.core.author_device_id}\n${record.core.device_sequence}`;
    const list = forkGroups.get(key) ?? [];
    list.push(record);
    forkGroups.set(key, list);
  }
  for (const group of forkGroups.values()) {
    if (group.length < 2) continue;
    const contenders = group.map((record) => record.event_id).sort();
    for (const id of contenders) forked.add(id);
    const first = group[0];
    forks.push(Object.freeze({
      schema_version: 1,
      object_kind: "semantic_device_fork",
      authority: "none",
      project_id: project,
      device_id: first.core.author_device_id,
      device_sequence: first.core.device_sequence,
      previous_device_event_id: first.core.previous_device_event_id,
      contender_event_ids: Object.freeze(contenders)
    }));
  }
  for (const id of forked) {
    classifications.set(
      id,
      semanticClassification(project, id, {
        disposition: "authority_conflict",
        reason: "same_device_fork",
        detail: "Multiple authenticated events claim the same device sequence."
      })
    );
  }

  const accepted = new Set<SemanticEventId>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (
        !baseValid.has(record.event_id) ||
        forked.has(record.event_id) ||
        accepted.has(record.event_id)
      ) continue;
      const dependencies = record.core.causal_parent_event_ids;
      if (dependencies.every((id) => accepted.has(id))) {
        accepted.add(record.event_id);
        changed = true;
      }
    }
  }

  for (const record of records) {
    if (accepted.has(record.event_id)) {
      classifications.set(
        record.event_id,
        semanticClassification(project, record.event_id, {
          disposition: "accepted",
          reason: "accepted",
          detail: "Semantic event passed full dependency, authority, and attestation validation."
        })
      );
    } else if (baseValid.has(record.event_id) && !forked.has(record.event_id)) {
      classifications.set(
        record.event_id,
        semanticClassification(project, record.event_id, {
          disposition: "pending",
          reason: "dependency_quarantined",
          detail: "A causal or same-device dependency is not currently accepted."
        })
      );
    }
  }

  const frontier = new Set(accepted);
  for (const record of records) {
    if (!accepted.has(record.event_id)) continue;
    for (const parent of record.core.causal_parent_event_ids) frontier.delete(parent);
  }
  return Object.freeze({
    classifications,
    accepted_ids: Object.freeze([...accepted].sort()),
    frontier: Object.freeze([...frontier].sort()),
    forks: Object.freeze(forks.sort((left, right) => {
      const leftKey = `${left.device_id}:${left.device_sequence}`;
      const rightKey = `${right.device_id}:${right.device_sequence}`;
      return leftKey < rightKey ? -1 : 1;
    }))
  });
}

async function validateSemanticBase(
  project: ProjectId,
  record: SemanticEventRecord,
  events: ReadonlyMap<SemanticEventId, SemanticEventRecord>,
  input: EventControlReconstructionInput,
  controls: ControlRebuild
): Promise<SemanticBaseResult> {
  try {
    const payload = input.payloads.get(record.core.semantic_payload_id);
    if (!payload) return pending("missing_payload", "Semantic payload has not arrived.");
    parseSemanticEventRecord(record, payload);
    if (payload.core.project_id !== project) {
      return invalid("cross_project_reference", "Semantic payload belongs to another project.");
    }
    const controlClassification = controls.classifications.get(
      record.core.authorizing_control_head_id
    );
    if (!controlClassification) {
      const foreignControl = input.control_events.get(
        record.core.authorizing_control_head_id
      );
      if (foreignControl && foreignControl.core.project_id !== project) {
        return invalid(
          "cross_project_reference",
          "Authorizing control head belongs to another project."
        );
      }
      return pending("missing_control_head", "Authorizing control head has not arrived.");
    }
    if (controlClassification.reason === "superseded_control_branch") {
      return conflict(
        "superseded_control_branch",
        "Semantic event is tied to a superseded control branch."
      );
    }
    if (controlClassification.disposition === "authority_conflict") {
      return conflict("disputed_control_head", "Authorizing control head is disputed.");
    }
    if (controlClassification.disposition !== "accepted") {
      return pending("control_state_unavailable", "Authorizing control state is unavailable.");
    }
    const authority = controls.authorities.get(record.core.authorizing_control_head_id);
    if (!authority) return pending("control_state_unavailable", "Control authority was not reconstructed.");
    if (record.core.key_epoch_id !== authority.key_epoch_id) {
      return conflict("unauthorized_device", "Semantic event uses the wrong key epoch.");
    }
    const device = authority.device_authorities.find(
      (fact) => fact.device_id === record.core.author_device_id
    );
    if (!device) return conflict("unauthorized_device", "Semantic author device is not authorized.");
    if (
      device.status === "revoked" &&
      (device.maximum_accepted_semantic_sequence === null ||
        record.core.device_sequence > device.maximum_accepted_semantic_sequence)
    ) {
      return conflict(
        "revoked_device_sequence",
        "Semantic sequence exceeds the device's accepted revocation cutoff."
      );
    }
    const requiredCapability = capabilityForPayload(payload);
    if (!device.capabilities.includes(requiredCapability)) {
      return conflict(
        "capability_denied",
        `Semantic payload requires ${requiredCapability}.`
      );
    }
    if (record.author_attestation_ids.length !== 1) {
      return invalid(
        "malformed_encoding",
        "Semantic event must contain exactly one mandatory author attestation."
      );
    }
    for (const id of record.author_attestation_ids) {
      const attestation = await verifySingleAttestation(
        id,
        input.attestations,
        input.attestation_verifier,
        {
          project_id: project,
          subject_kind: "semantic_event",
          subject_id: record.event_id,
          expected_key_id: device.signing_key_id,
          referenced_control_head_id: record.core.authorizing_control_head_id,
          root_authority_context_id: null,
          expected_device_id: device.device_id,
          expected_person_id: device.person_id
        }
      );
      if (!attestation.ok) return attestation;
    }

    if (record.core.previous_device_event_id !== null) {
      const previous = events.get(record.core.previous_device_event_id);
      if (!previous) {
        const foreignPrevious = input.semantic_events.get(
          record.core.previous_device_event_id
        );
        if (foreignPrevious && foreignPrevious.core.project_id !== project) {
          return invalid(
            "cross_project_reference",
            "Previous same-device event belongs to another project."
          );
        }
        return pending(
          "missing_previous_device_event",
          "Previous same-device semantic event has not arrived."
        );
      }
      if (
        previous.core.project_id !== project ||
        previous.core.author_device_id !== record.core.author_device_id
      ) {
        return invalid(
          "invalid_previous_link",
          "Previous same-device event has incorrect project or device ownership."
        );
      }
      const expected = nextUInt64(previous.core.device_sequence, "device sequence");
      if (record.core.device_sequence !== expected) {
        return record.core.device_sequence > expected
          ? pending("device_sequence_gap", "Semantic device sequence contains a gap.")
          : invalid("sequence_regression", "Semantic device sequence regresses or repeats.");
      }
    }
    for (const parentId of record.core.causal_parent_event_ids) {
      const parent = events.get(parentId);
      if (!parent) {
        const foreignParent = input.semantic_events.get(parentId);
        if (foreignParent && foreignParent.core.project_id !== project) {
          return invalid("cross_project_reference", "Causal parent belongs to another project.");
        }
        return pending("missing_causal_parent", `Causal parent ${parentId} has not arrived.`);
      }
      if (parent.core.project_id !== project) {
        return invalid("cross_project_reference", "Causal parent belongs to another project.");
      }
    }
    const contentDependency = await validatePayloadContentDependencies(
      payload,
      input.revision_store
    );
    if (contentDependency) return contentDependency;
    const reviewEvidence = await validateReviewResponseEvidence(
      project,
      record,
      payload,
      events,
      input.payloads
    );
    if (reviewEvidence) return reviewEvidence;
    return Object.freeze({ ok: true });
  } catch (error) {
    return invalid("malformed_encoding", errorMessage(error));
  }
}

async function validateReviewResponseEvidence(
  project: ProjectId,
  record: SemanticEventRecord,
  payload: SemanticPayloadRecord,
  events: ReadonlyMap<SemanticEventId, SemanticEventRecord>,
  payloads: ReadonlyMap<string, SemanticPayloadRecord>
): Promise<SemanticBaseResult | null> {
  const responses = payload.core.semantic_kind === "review_batch_operation" &&
      payload.core.data.operation === "respond"
    ? [payload.core.data]
    : payload.core.semantic_kind === "collaboration_bootstrap_import"
      ? payload.core.data.review_batches.filter(
          (batch) => batch.response_evidence_commitment !== null
        )
      : [];

  for (const response of responses) {
    if (
      response.response_evidence_commitment === null ||
      response.response_import_id === null
    ) {
      return invalid(
        "malformed_encoding",
        "A responded review batch must carry its evidence commitment and import ID."
      );
    }
    const validCommitment = await verifyReviewResponseEvidenceCommitment({
      schema_version: 1,
      project_id: project,
      review_batch_id: response.review_batch_id,
      response_import_id: response.response_import_id,
      contribution_payload_ids: response.contribution_payload_ids
    }, response.response_evidence_commitment);
    if (!validCommitment) {
      return invalid(
        "digest_id_mismatch",
        "Review response evidence commitment does not match its exact canonical preimage."
      );
    }
    for (const contributionId of response.contribution_payload_ids) {
      const contribution = payloads.get(contributionId);
      if (!contribution) {
        return pending(
          "missing_payload",
          `Review contribution payload ${contributionId} has not arrived.`
        );
      }
      if (contribution.core.project_id !== project) {
        return invalid(
          "cross_project_reference",
          "Review contribution payload belongs to another project."
        );
      }
      if (!isMatchingReviewContribution(
        contribution,
        response.review_batch_id,
        response.response_import_id
      )) {
        return invalid(
          "forbidden_or_circular_reference",
          "Review contribution payload is not a supporting reply or patch bound to the same response."
        );
      }
      if (
        payload.core.semantic_kind === "review_batch_operation" &&
        ![...events.values()].some(
          (candidate) =>
            candidate.core.project_id === project &&
            candidate.core.semantic_payload_id === contributionId &&
            isCausalAncestor(candidate.event_id, record, events)
        )
      ) {
        return invalid(
          "forbidden_or_circular_reference",
          "A live review response may reference only causally prior contribution payloads."
        );
      }
    }
  }
  return null;
}

function isMatchingReviewContribution(
  payload: SemanticPayloadRecord,
  reviewBatchId: import("./identities.ts").ReviewBatchId,
  responseImportId: import("./review-response-evidence.ts").ReviewResponseImportId
): boolean {
  if (
    payload.core.semantic_kind === "reply_operation" &&
    (payload.core.data.operation === "create" || payload.core.data.operation === "edit")
  ) {
    return payload.core.data.review_batch_id === reviewBatchId &&
      payload.core.data.response_import_id === responseImportId;
  }
  if (
    payload.core.semantic_kind === "patch_operation" &&
    (payload.core.data.operation === "propose" || payload.core.data.operation === "edit")
  ) {
    return payload.core.data.review_batch_id === reviewBatchId &&
      payload.core.data.response_import_id === responseImportId;
  }
  return false;
}

function isCausalAncestor(
  candidateId: SemanticEventId,
  descendant: SemanticEventRecord,
  events: ReadonlyMap<SemanticEventId, SemanticEventRecord>
): boolean {
  const pendingIds = [...descendant.core.causal_parent_event_ids];
  const visited = new Set<SemanticEventId>();
  while (pendingIds.length > 0) {
    const id = pendingIds.pop()!;
    if (id === candidateId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const event = events.get(id);
    if (event) pendingIds.push(...event.core.causal_parent_event_ids);
  }
  return false;
}

async function validatePayloadContentDependencies(
  payload: SemanticPayloadRecord,
  revisionStore: ImmutableCollaborationStore
): Promise<SemanticBaseResult | null> {
  const revisions: Array<Readonly<{ id: import("./identities.ts").DocumentRevisionId; document_id?: string }>> = [];
  switch (payload.core.semantic_kind) {
    case "project_genesis":
      revisions.push(...payload.core.data.genesis_revision_ids.map((id) => ({ id })));
      break;
    case "collaboration_bootstrap_import":
      for (const document of payload.core.data.documents) {
        revisions.push({
          id: document.baseline_revision_id,
          document_id: document.document_id
        });
        for (const patch of document.patches) {
          for (const version of patch.versions) {
            if (version.revision_id !== null) {
              revisions.push({
                id: version.revision_id,
                document_id: document.document_id
              });
            }
          }
        }
      }
      for (const session of payload.core.data.rewrite_sessions) {
        for (const revisionId of session.applied_revision_ids) {
          revisions.push({ id: revisionId, document_id: session.document_id });
        }
      }
      for (const evidence of payload.core.data.imported_legacy_versions) {
        const blob = await revisionStore.getMarkdownBlob(
          payload.core.project_id,
          evidence.markdown_blob_id
        );
        if (blob.status === "missing" || blob.status === "incomplete") {
          return pending("missing_payload", "Imported legacy Markdown evidence has not arrived.");
        }
        if (blob.status !== "valid") {
          return invalid("corrupted_dependency", `Imported legacy Markdown evidence is ${blob.status}.`);
        }
      }
      break;
    case "revision_adoption":
    case "merge_revision_adoption":
      revisions.push({
        id: payload.core.data.revision_id,
        document_id: payload.core.data.document_id
      });
      break;
    case "external_revision_import": {
      revisions.push({
        id: payload.core.data.revision_id,
        document_id: payload.core.data.document_id
      });
      const blob = await revisionStore.getMarkdownBlob(
        payload.core.project_id,
        payload.core.data.imported_blob_id
      );
      if (blob.status === "missing" || blob.status === "incomplete") {
        return pending("missing_payload", "Imported Markdown blob has not arrived.");
      }
      if (blob.status !== "valid") {
        return invalid("corrupted_dependency", `Imported Markdown blob is ${blob.status}.`);
      }
      break;
    }
    case "patch_operation":
      if (
        payload.core.data.operation !== "decide" &&
        payload.core.data.revision_id !== undefined
      ) {
        revisions.push({
          id: payload.core.data.revision_id,
          document_id: payload.core.data.document_id
        });
      }
      break;
    case "rewrite_operation":
      if (payload.core.data.operation === "apply") {
        revisions.push({
          id: payload.core.data.revision_id,
          document_id: payload.core.data.document_id
        });
      }
      break;
    case "conflict_resolution":
      if (payload.core.data.adopted_revision_id !== null) {
        revisions.push({ id: payload.core.data.adopted_revision_id });
      }
      break;
    case "consolidation_checkpoint":
      for (const operation of payload.core.data.resolution_operations) {
        if (operation.operation_kind === "resolve_content_conflict") {
          revisions.push({ id: operation.adopted_revision_id });
        }
      }
      break;
    default:
      break;
  }
  for (const dependency of revisions) {
    const revision = await revisionStore.getRevision(dependency.id);
    if (revision.status === "missing" || revision.status === "incomplete") {
      return pending("missing_payload", `Referenced revision ${dependency.id} has not arrived.`);
    }
    if (revision.status !== "valid") {
      return invalid("corrupted_dependency", `Referenced revision is ${revision.status}.`);
    }
    if (
      revision.value.core.project_id !== payload.core.project_id ||
      (dependency.document_id !== undefined &&
        revision.value.core.document_id !== dependency.document_id)
    ) {
      return invalid("cross_project_reference", "Referenced revision ownership does not match payload.");
    }
  }
  return null;
}

type AttestationExpectation = Readonly<{
  project_id: ProjectId;
  subject_kind: "semantic_event" | "control_event";
  subject_id: SemanticEventId | ControlEventId;
  expected_key_id: PublicKeyId;
  referenced_control_head_id: ControlEventId | null;
  root_authority_context_id: ControlEventId | null;
  expected_device_id: DeviceId | null;
  expected_person_id: import("./identities.ts").PersonId | null;
}>;

async function verifySingleAttestation(
  id: AttestationId,
  attestations: ReadonlyMap<string, AttestationRecord>,
  verifier: CollaborationAttestationVerifier,
  expected: AttestationExpectation
): Promise<ValidationGate> {
  const attestation = attestations.get(id);
  if (!attestation) return pending("missing_attestation", `Attestation ${id} has not arrived.`);
  const core = attestation.core;
  if (
    core.project_id !== expected.project_id ||
    core.subject_kind !== expected.subject_kind ||
    core.subject_id !== expected.subject_id ||
    core.signer_key_id !== expected.expected_key_id
  ) {
    return invalid("invalid_attestation", "Attestation subject, project, or signer binding is incorrect.");
  }
  const digestKind = expected.subject_kind === "semantic_event"
    ? "semantic-event" as const
    : "control-event" as const;
  const request: AttestationVerificationRequest = Object.freeze({
    schema_version: 1,
    project_id: expected.project_id,
    subject_kind: expected.subject_kind,
    subject_id: expected.subject_id,
    raw_subject_digest: digestBytesFromId(digestKind, expected.subject_id as never),
    signature_preimage: encodeCanonicalCbor(
      buildSignaturePreimage(
        expected.subject_kind,
        expected.project_id,
        expected.subject_id as never
      )
    ),
    signer_key_id: core.signer_key_id,
    algorithm: core.algorithm,
    signature_bytes: Uint8Array.from(core.signature_bytes),
    referenced_control_head_id: expected.referenced_control_head_id,
    root_authority_context_id: expected.root_authority_context_id,
    expected_device_id: expected.expected_device_id,
    expected_person_id: expected.expected_person_id
  });
  const result = await verifier.verify(copyAttestationRequest(request));
  if (result?.outcome === "unavailable") {
    return pending("missing_verification_material", result.reason);
  }
  if (!result || result.outcome !== "verified") {
    return invalid(
      "invalid_attestation",
      result && result.outcome === "invalid"
        ? result.reason
        : "Attestation verifier returned an unbound result."
    );
  }
  if (!sameAttestationRequest(request, result.binding)) {
    return invalid("invalid_attestation", "Attestation verification result is not bound to the exact request.");
  }
  return Object.freeze({ ok: true });
}

async function verifyTransition(
  request: ControlTransitionVerificationRequest,
  verifier: CollaborationControlTransitionVerifier
): Promise<ControlValidationResult> {
  const result = await verifier.verify(copyTransitionRequest(request));
  if (result?.outcome === "unavailable") {
    return pending("control_state_unavailable", result.reason);
  }
  if (!result || result.outcome !== "verified") {
    return invalid(
      "invalid_previous_link",
      result && result.outcome === "invalid"
        ? result.reason
        : "Control transition verifier returned an unbound result."
    );
  }
  if (!sameTransitionRequest(request, result.binding)) {
    return invalid(
      "invalid_previous_link",
      "Control transition result is not bound to the exact transition request."
    );
  }
  let authority: ControlAuthorityState;
  try {
    authority = parseAuthorityState(result.resulting_authority, request);
  } catch (error) {
    return invalid("invalid_previous_link", errorMessage(error));
  }
  return Object.freeze({ ok: true, authority });
}

function transitionRequest(
  record: ControlEventRecord,
  previous: ControlAuthorityState | null,
  action: ControlActionRecord | null
): ControlTransitionVerificationRequest {
  const core = record.core;
  const keyEpochId = core.control_kind === "genesis"
    ? core.initial_key_epoch_id
    : core.key_epoch_id;
  const keyEpochCommitment = core.control_kind === "genesis"
    ? core.initial_key_epoch_commitment
    : core.key_epoch_commitment;
  const recovery = action?.core.action_kind === "root_recovery" ? action.core : null;
  return Object.freeze({
    schema_version: 1,
    project_id: core.project_id,
    control_event_id: record.control_event_id,
    control_kind: core.control_kind,
    previous_control_id: core.previous_control_id,
    previous_root_control_id: core.control_kind === "genesis"
      ? null
      : core.control_kind === "root_recovery"
        ? core.previous_root_control_id
        : null,
    previous_control_state_root: previous?.control_state_root ?? null,
    control_action_id: core.control_kind === "genesis" ? null : core.action_id,
    issuer_device_id: core.control_kind === "ordinary" ? core.issuer_device_id : null,
    issuer_root_key_id: core.control_kind === "genesis"
      ? core.offline_root_key_id
      : core.control_kind === "root_recovery"
        ? core.issuer_root_key_id
        : null,
    expected_control_sequence: core.control_sequence,
    expected_root_sequence: core.control_kind === "ordinary"
      ? null
      : core.root_sequence,
    resulting_control_state_root: core.resulting_control_state_root,
    previous_active_control_device_id: previous?.active_control_device_id ?? null,
    previous_device_authorities: previous?.device_authorities ?? Object.freeze([]),
    key_epoch_id: keyEpochId,
    key_epoch_commitment: keyEpochCommitment,
    recovery_last_uncontested_control_id: recovery?.last_uncontested_control_id ?? null,
    recovery_selected_state_root: recovery?.selected_membership_device_state_root ?? null,
    recovery_replacement_active_control_device_id:
      recovery?.replacement_active_control_device_id ?? null,
    recovery_revocation_sequence_cutoffs:
      recovery?.revocation_sequence_cutoffs ?? Object.freeze([]),
    recovery_observed_conflicting_tip_ids:
      recovery?.observed_conflicting_tip_ids ?? Object.freeze([]),
    recovery_supersession_policy: recovery?.supersession_policy ?? null
  });
}

function genesisAuthority(record: ControlEventRecord): ControlAuthorityState {
  if (record.core.control_kind !== "genesis") {
    throw new Error("Genesis authority requires a genesis control event.");
  }
  const memberships = new Map(
    record.core.initial_memberships.map((membership) => [membership.person_id, membership.role])
  );
  const facts = record.core.initial_authorized_devices.map((device) => {
    const role = memberships.get(device.person_id);
    if (!role) throw new Error("Initial authorized device has no active membership.");
    return authorityFact(
      device.device_id,
      device.person_id,
      device.signing_key_id,
      role,
      "active",
      null
    );
  }).sort((left, right) => left.device_id < right.device_id ? -1 : 1);
  return Object.freeze({
    schema_version: 1,
    project_id: record.core.project_id,
    control_event_id: record.control_event_id,
    control_state_root: record.core.resulting_control_state_root,
    active_control_device_id: record.core.initial_active_control_device_id,
    offline_root_key_id: record.core.offline_root_key_id,
    key_epoch_id: record.core.initial_key_epoch_id,
    key_epoch_commitment: record.core.initial_key_epoch_commitment,
    device_authorities: Object.freeze(facts)
  });
}

function parseAuthorityState(
  value: ControlAuthorityState,
  request: ControlTransitionVerificationRequest
): ControlAuthorityState {
  if (!value || typeof value !== "object") {
    throw new Error("Control transition authority result must be structured.");
  }
  if (
    value.schema_version !== 1 ||
    parseEntityId("project", value.project_id) !== request.project_id ||
    parseDigestId("control-event", value.control_event_id) !== request.control_event_id ||
    parseDigestId("control-state-root", value.control_state_root) !==
      request.resulting_control_state_root ||
    parseEntityId("key-epoch", value.key_epoch_id) !== request.key_epoch_id ||
    parseDigestId("key-epoch-commitment", value.key_epoch_commitment) !==
      request.key_epoch_commitment
  ) {
    throw new Error("Control transition authority result is not bound to its event and state root.");
  }
  const active = parseEntityId("device", value.active_control_device_id);
  const rootKey = parseEntityId("public-key", value.offline_root_key_id);
  if (!Array.isArray(value.device_authorities) || value.device_authorities.length === 0) {
    throw new Error("Control authority requires device authority facts.");
  }
  const facts = value.device_authorities.map((fact) => parseAuthorityFact(fact));
  for (let index = 1; index < facts.length; index += 1) {
    if (facts[index - 1].device_id >= facts[index].device_id) {
      throw new Error("Device authority facts must be strictly sorted and unique.");
    }
  }
  if (!facts.some((fact) => fact.device_id === active && fact.status === "active")) {
    throw new Error("Active control device must be an active authorized device.");
  }
  return Object.freeze({
    schema_version: 1,
    project_id: request.project_id,
    control_event_id: request.control_event_id,
    control_state_root: request.resulting_control_state_root,
    active_control_device_id: active,
    offline_root_key_id: rootKey,
    key_epoch_id: request.key_epoch_id,
    key_epoch_commitment: request.key_epoch_commitment,
    device_authorities: Object.freeze(facts)
  });
}

function parseAuthorityFact(value: DeviceAuthorityFact): DeviceAuthorityFact {
  if (!value || typeof value !== "object") throw new Error("Invalid device authority fact.");
  const role = parseRole(value.role);
  const expectedCapabilities = capabilitiesForRole(role);
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length !== expectedCapabilities.length ||
    value.capabilities.some((capability, index) => capability !== expectedCapabilities[index])
  ) {
    throw new Error("Device authority capabilities must exactly match the declared role.");
  }
  const status = value.status;
  if (status !== "active" && status !== "revoked") {
    throw new Error("Device authority status is unknown.");
  }
  const cutoff = value.maximum_accepted_semantic_sequence === null
    ? null
    : expectUInt64(value.maximum_accepted_semantic_sequence, "device authority cutoff");
  if (status === "active" && cutoff !== null) {
    throw new Error("Active devices cannot carry a revocation cutoff.");
  }
  return authorityFact(
    parseEntityId("device", value.device_id),
    parseEntityId("person", value.person_id),
    parseEntityId("public-key", value.signing_key_id),
    role,
    status,
    cutoff
  );
}

function authorityFact(
  deviceId: DeviceId,
  personId: import("./identities.ts").PersonId,
  keyId: PublicKeyId,
  role: CollaborationRole,
  status: "active" | "revoked",
  cutoff: UInt64 | null
): DeviceAuthorityFact {
  return Object.freeze({
    device_id: deviceId,
    person_id: personId,
    signing_key_id: keyId,
    role,
    capabilities: Object.freeze([...capabilitiesForRole(role)]),
    status,
    maximum_accepted_semantic_sequence: cutoff
  });
}

function capabilityForPayload(payload: SemanticPayloadRecord): CollaborationCapability {
  switch (payload.core.semantic_kind) {
    case "project_genesis":
      return "create_revision";
    case "collaboration_bootstrap_import":
      return "create_revision";
    case "revision_adoption":
      return "adopt_revision";
    case "merge_revision_adoption":
      return "authorize_safe_merge";
    case "external_revision_import":
      return "import_model_work";
    case "comment_operation":
      return payload.core.data.operation === "create"
        ? "create_comment"
        : payload.core.data.operation === "resolve"
          ? "resolve_comment"
          : "edit_comment";
    case "reply_operation":
      return payload.core.data.operation === "create" ? "create_reply" : "edit_comment";
    case "patch_operation":
      if (payload.core.data.operation !== "decide") return "propose_patch";
      return payload.core.data.decision === "accepted"
        ? "accept_patch"
        : "reject_patch";
    case "metadata_operation":
      return payload.core.data.operation.startsWith("group_")
        ? "create_group"
        : payload.core.data.operation.startsWith("document_")
          ? "create_document"
          : "edit_markdown";
    case "review_batch_operation":
      return "import_model_work";
    case "rewrite_operation":
      return payload.core.data.operation === "apply"
        ? "adopt_revision"
        : "edit_markdown";
    case "conflict_resolution":
    case "consolidation_checkpoint":
      return "resolve_content_conflict";
  }
}

function rootForkRecords(
  project: ProjectId,
  records: readonly ControlEventRecord[],
  provisional: ReadonlySet<ControlEventId>
): RootControlForkRecord[] {
  const groups = new Map<string, ControlEventRecord[]>();
  for (const record of records) {
    if (!provisional.has(record.control_event_id) || record.core.control_kind === "ordinary") {
      continue;
    }
    const previous = record.core.control_kind === "genesis"
      ? null
      : record.core.previous_root_control_id;
    const key = `${previous ?? "genesis"}\n${record.core.root_sequence}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  const forks: RootControlForkRecord[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    if (first.core.control_kind === "ordinary") continue;
    forks.push(Object.freeze({
      schema_version: 1,
      object_kind: "root_control_fork",
      authority: "none",
      project_id: project,
      previous_root_control_id: first.core.control_kind === "genesis"
        ? null
        : first.core.previous_root_control_id,
      root_sequence: first.core.root_sequence,
      contender_control_event_ids: Object.freeze(
        group.map((record) => record.control_event_id).sort()
      )
    }));
  }
  return forks.sort((left, right) => {
    const leftId = left.contender_control_event_ids[0];
    const rightId = right.contender_control_event_ids[0];
    return leftId < rightId ? -1 : 1;
  });
}

function firstChildAfter(
  ancestor: ControlEventId,
  descendant: ControlEventId,
  records: ReadonlyMap<ControlEventId, ControlEventRecord>
): ControlEventId | null {
  if (ancestor === descendant) return null;
  let current = records.get(descendant);
  const seen = new Set<ControlEventId>();
  while (current && current.core.previous_control_id !== null) {
    if (seen.has(current.control_event_id)) return null;
    seen.add(current.control_event_id);
    if (current.core.previous_control_id === ancestor) return current.control_event_id;
    current = records.get(current.core.previous_control_id);
  }
  return null;
}

function isDescendantOf(
  ancestor: ControlEventId,
  descendant: ControlEventId,
  records: ReadonlyMap<ControlEventId, ControlEventRecord>
): boolean {
  return ancestor === descendant || firstChildAfter(ancestor, descendant, records) !== null;
}

function buildAttestationIndex(
  project: ProjectId,
  attestations: ReadonlyMap<string, AttestationRecord>
): readonly AttestationIndexEntry[] {
  const groups = new Map<string, AttestationIndexEntry>();
  for (const record of attestations.values()) {
    if (
      record.core.project_id !== project ||
      (record.core.subject_kind !== "semantic_event" &&
        record.core.subject_kind !== "control_event")
    ) continue;
    const key = `${record.core.subject_kind}\n${record.core.subject_id}`;
    const subjectId = record.core.subject_kind === "semantic_event"
      ? parseDigestId("semantic-event", record.core.subject_id)
      : parseDigestId("control-event", record.core.subject_id);
    const existing = groups.get(key);
    const ids = existing ? [...existing.attestation_ids, record.attestation_id] : [record.attestation_id];
    groups.set(key, Object.freeze({
      subject_kind: record.core.subject_kind,
      subject_id: subjectId,
      attestation_ids: Object.freeze([...new Set(ids)].sort())
    }));
  }
  return Object.freeze([...groups.values()].sort((left, right) => {
    const leftKey = `${left.subject_kind}:${left.subject_id}`;
    const rightKey = `${right.subject_kind}:${right.subject_id}`;
    return leftKey < rightKey ? -1 : 1;
  }));
}

function controlClassification(
  project: ProjectId,
  id: ControlEventId,
  result: Readonly<{
    disposition: ClassificationDisposition;
    reason: ClassificationReason;
    detail: string;
  }>
): ControlEventClassification {
  return Object.freeze({
    schema_version: 1,
    object_kind: "control_event",
    project_id: project,
    object_id: id,
    disposition: result.disposition,
    reason: result.reason,
    detail: result.detail
  });
}

function semanticClassification(
  project: ProjectId,
  id: SemanticEventId,
  result: Readonly<{
    disposition: ClassificationDisposition;
    reason: ClassificationReason;
    detail: string;
  }>
): SemanticEventClassification {
  return Object.freeze({
    schema_version: 1,
    object_kind: "semantic_event",
    project_id: project,
    object_id: id,
    disposition: result.disposition,
    reason: result.reason,
    detail: result.detail
  });
}

function pending(
  reason: Extract<ClassificationReason,
    | "missing_payload"
    | "missing_action"
    | "missing_causal_parent"
    | "missing_previous_device_event"
    | "device_sequence_gap"
    | "missing_control_head"
    | "missing_attestation"
    | "missing_verification_material"
    | "dependency_quarantined"
    | "control_state_unavailable">,
  detail: string
): Readonly<{ ok: false; disposition: "pending"; reason: typeof reason; detail: string }> {
  return Object.freeze({ ok: false, disposition: "pending", reason, detail });
}

function conflict(
  reason: Extract<ClassificationReason,
    | "same_device_fork"
    | "control_fork"
    | "root_fork"
    | "disputed_control_head"
    | "superseded_control_branch"
    | "unauthorized_device"
    | "capability_denied"
    | "non_designated_control_issuer"
    | "revoked_device_sequence">,
  detail: string
): Readonly<{ ok: false; disposition: "authority_conflict"; reason: typeof reason; detail: string }> {
  return Object.freeze({ ok: false, disposition: "authority_conflict", reason, detail });
}

function invalid(
  reason: Extract<ClassificationReason,
    | "malformed_encoding"
    | "noncanonical_encoding"
    | "digest_id_mismatch"
    | "cross_project_reference"
    | "cross_namespace_reference"
    | "invalid_attestation"
    | "unknown_protocol_value"
    | "sequence_regression"
    | "invalid_previous_link"
    | "forbidden_or_circular_reference"
    | "corrupted_dependency">,
  detail: string
): Readonly<{ ok: false; disposition: "permanently_invalid"; reason: typeof reason; detail: string }> {
  return Object.freeze({ ok: false, disposition: "permanently_invalid", reason, detail });
}

function nextUInt64(value: UInt64, label: string): UInt64 {
  return expectUInt64(value + BigInt(1), label);
}

function parseRole(value: unknown): CollaborationRole {
  if (value === "owner" || value === "editor" || value === "reviewer") return value;
  throw new Error("Unknown collaboration role.");
}

function copyAttestationRequest(
  value: AttestationVerificationRequest
): AttestationVerificationRequest {
  return Object.freeze({
    ...value,
    raw_subject_digest: Uint8Array.from(value.raw_subject_digest),
    signature_preimage: Uint8Array.from(value.signature_preimage),
    signature_bytes: Uint8Array.from(value.signature_bytes)
  });
}

function sameAttestationRequest(
  left: AttestationVerificationRequest,
  right: AttestationVerificationRequest
): boolean {
  return !!right &&
    left.schema_version === right.schema_version &&
    left.project_id === right.project_id &&
    left.subject_kind === right.subject_kind &&
    left.subject_id === right.subject_id &&
    bytesSame(left.raw_subject_digest, right.raw_subject_digest) &&
    bytesSame(left.signature_preimage, right.signature_preimage) &&
    left.signer_key_id === right.signer_key_id &&
    left.algorithm === right.algorithm &&
    bytesSame(left.signature_bytes, right.signature_bytes) &&
    left.referenced_control_head_id === right.referenced_control_head_id &&
    left.root_authority_context_id === right.root_authority_context_id &&
    left.expected_device_id === right.expected_device_id &&
    left.expected_person_id === right.expected_person_id;
}

function copyTransitionRequest(
  value: ControlTransitionVerificationRequest
): ControlTransitionVerificationRequest {
  return Object.freeze({
    ...value,
    previous_device_authorities: Object.freeze([...value.previous_device_authorities]),
    recovery_revocation_sequence_cutoffs: Object.freeze(
      value.recovery_revocation_sequence_cutoffs.map((cutoff) =>
        Object.freeze({ ...cutoff })
      )
    ),
    recovery_observed_conflicting_tip_ids: Object.freeze([
      ...value.recovery_observed_conflicting_tip_ids
    ])
  });
}

function sameTransitionRequest(
  left: ControlTransitionVerificationRequest,
  right: ControlTransitionVerificationRequest
): boolean {
  if (!right) return false;
  const scalarKeys = [
    "schema_version",
    "project_id",
    "control_event_id",
    "control_kind",
    "previous_control_id",
    "previous_root_control_id",
    "previous_control_state_root",
    "control_action_id",
    "issuer_device_id",
    "issuer_root_key_id",
    "expected_control_sequence",
    "expected_root_sequence",
    "resulting_control_state_root",
    "previous_active_control_device_id",
    "key_epoch_id",
    "key_epoch_commitment",
    "recovery_last_uncontested_control_id",
    "recovery_selected_state_root",
    "recovery_replacement_active_control_device_id",
    "recovery_supersession_policy"
  ] as const;
  if (scalarKeys.some((key) => left[key] !== right[key])) return false;
  if (!sameStrings(
    left.recovery_observed_conflicting_tip_ids,
    right.recovery_observed_conflicting_tip_ids
  )) return false;
  if (
    left.recovery_revocation_sequence_cutoffs.length !==
      right.recovery_revocation_sequence_cutoffs.length ||
    left.recovery_revocation_sequence_cutoffs.some((cutoff, index) => {
      const other = right.recovery_revocation_sequence_cutoffs[index];
      return !other ||
        cutoff.device_id !== other.device_id ||
        cutoff.maximum_accepted_semantic_sequence !==
          other.maximum_accepted_semantic_sequence;
    })
  ) return false;
  return sameAuthorityFacts(
    left.previous_device_authorities,
    right.previous_device_authorities
  );
}

function sameAuthority(left: ControlAuthorityState, right: ControlAuthorityState): boolean {
  return left.project_id === right.project_id &&
    left.control_event_id === right.control_event_id &&
    left.control_state_root === right.control_state_root &&
    left.active_control_device_id === right.active_control_device_id &&
    left.offline_root_key_id === right.offline_root_key_id &&
    left.key_epoch_id === right.key_epoch_id &&
    left.key_epoch_commitment === right.key_epoch_commitment &&
    sameAuthorityFacts(left.device_authorities, right.device_authorities);
}

function sameAuthorityFacts(
  left: readonly DeviceAuthorityFact[],
  right: readonly DeviceAuthorityFact[]
): boolean {
  return left.length === right.length && left.every((fact, index) => {
    const other = right[index];
    return !!other &&
      fact.device_id === other.device_id &&
      fact.person_id === other.person_id &&
      fact.signing_key_id === other.signing_key_id &&
      fact.role === other.role &&
      sameStrings(fact.capabilities, other.capabilities) &&
      fact.status === other.status &&
      fact.maximum_accepted_semantic_sequence ===
        other.maximum_accepted_semantic_sequence;
  });
}

function bytesSame(left: Uint8Array, right: Uint8Array): boolean {
  return left instanceof Uint8Array && right instanceof Uint8Array &&
    left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function byObjectId(
  left: { object_id: string },
  right: { object_id: string }
): number {
  return left.object_id < right.object_id ? -1 : left.object_id > right.object_id ? 1 : 0;
}

function frozenSortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { CollaborationRole } from "./capabilities.ts";
import { collaborationRoles } from "./capabilities.ts";
import { decodeSha256Base32 } from "./base32.ts";
import {
  CONTROL_ACTION_SCHEMA_VERSION,
  CONTROL_EVENT_CORE_SCHEMA_VERSION,
  CONTROL_EVENT_RECORD_VERSION,
  DERIVED_CONFLICT_SCHEMA_VERSION
} from "./versions.ts";
import {
  type AccessScopeId,
  type AttestationId,
  type ControlActionId,
  type ControlEventId,
  type ControlStateRootId,
  type DerivedConflictId,
  type DeviceId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type MembershipId,
  type PersonId,
  type ProjectId,
  type PublicKeyId,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  type NonAuthoritativeTimestamp,
  type UInt64,
  expectDisplayTimestamp,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectPositiveUInt64,
  expectUInt64,
  expectZeroUInt64,
  freezeRecord,
  parseSortedUniqueArray,
  parseUniqueArray
} from "./validation.ts";

export type InitialMembership = Readonly<{
  membership_id: MembershipId;
  person_id: PersonId;
  role: CollaborationRole;
  access_scope_id: AccessScopeId;
  status: "active";
}>;

export type InitialAuthorizedDevice = Readonly<{
  device_id: DeviceId;
  person_id: PersonId;
  signing_key_id: PublicKeyId;
  status: "active";
}>;

type ControlActionBase<TKind extends string> = Readonly<{
  schema_version: typeof CONTROL_ACTION_SCHEMA_VERSION;
  project_id: ProjectId;
  action_kind: TKind;
}>;

export type MembershipGrantAction = ControlActionBase<"membership_grant"> &
  Readonly<{
    membership_id: MembershipId;
    person_id: PersonId;
    role: CollaborationRole;
    access_scope_id: AccessScopeId;
  }>;

export type MembershipRoleChangeAction =
  ControlActionBase<"membership_role_change"> &
    Readonly<{
      membership_id: MembershipId;
      person_id: PersonId;
      next_role: CollaborationRole;
    }>;

export type MembershipRevocationAction =
  ControlActionBase<"membership_revocation"> &
    Readonly<{
      membership_id: MembershipId;
      person_id: PersonId;
      revocation_cutoffs: readonly DeviceSequenceCutoff[];
    }>;

export type DeviceAuthorizationAction =
  ControlActionBase<"device_authorization"> &
    Readonly<{
      person_id: PersonId;
      device_id: DeviceId;
      signing_key_id: PublicKeyId;
    }>;

export type DeviceRevocationAction = ControlActionBase<"device_revocation"> &
  Readonly<{
    person_id: PersonId;
    device_id: DeviceId;
    semantic_sequence_cutoff: UInt64;
  }>;

export type ActiveControlDeviceTransferAction =
  ControlActionBase<"active_control_device_transfer"> &
    Readonly<{
      previous_active_control_device_id: DeviceId;
      replacement_active_control_device_id: DeviceId;
    }>;

export type KeyEpochTransitionAction =
  ControlActionBase<"key_epoch_transition"> &
    Readonly<{
      previous_key_epoch_id: KeyEpochId;
      replacement_key_epoch_id: KeyEpochId;
      replacement_key_epoch_commitment: KeyEpochCommitmentId;
      reason: "membership_change" | "device_revocation" | "periodic_rotation";
    }>;

export type Hc2InvitationCreateAction =
  ControlActionBase<"hc2_invitation_create"> &
    Readonly<{
      invitation_id: import("./identities.ts").InvitationId;
      inviting_membership_id: MembershipId;
      inviting_person_id: PersonId;
      inviting_device_id: DeviceId;
      intended_role: CollaborationRole;
      access_scope: "project_wide";
      access_scope_id: AccessScopeId;
      creation_control_head_id: ControlEventId;
      valid_through_control_sequence: UInt64;
      suite_id: "patchmark/hc2/crypto-suite/v1";
    }>;

export type Hc2InvitationCancelAction =
  ControlActionBase<"hc2_invitation_cancel"> &
    Readonly<{
      invitation_id: import("./identities.ts").InvitationId;
      invitation_control_event_id: ControlEventId;
      suite_id: "patchmark/hc2/crypto-suite/v1";
    }>;

export type Hc2MembershipEpochTransitionAction =
  ControlActionBase<"hc2_membership_epoch_transition"> &
    Readonly<{
      transition_id: string;
      transition_kind: "new_membership" | "additional_device" | "role_change" | "device_revocation" | "membership_revocation";
      recipient_manifest_id: string;
      delivery_set_id: string;
      previous_key_epoch_id: KeyEpochId;
      replacement_key_epoch_id: KeyEpochId;
      replacement_key_epoch_commitment: KeyEpochCommitmentId;
      replacement_active_control_device_id: DeviceId;
      suite_id: "patchmark/hc2/crypto-suite/v1";
    }>;

export type DeviceSequenceCutoff = Readonly<{
  device_id: DeviceId;
  maximum_accepted_semantic_sequence: UInt64;
}>;

export type RootRecoveryAction = ControlActionBase<"root_recovery"> &
  Readonly<{
    last_uncontested_control_id: ControlEventId;
    selected_membership_device_state_root: ControlStateRootId;
    revocation_sequence_cutoffs: readonly DeviceSequenceCutoff[];
    replacement_active_control_device_id: DeviceId;
    replacement_key_epoch_id: KeyEpochId;
    replacement_key_epoch_commitment: KeyEpochCommitmentId;
    observed_conflicting_tip_ids: readonly ControlEventId[];
    supersession_policy: "supersede_all_ordinary_descendants_outside_recovery_chain";
  }>;

export type ControlActionCore =
  | MembershipGrantAction
  | MembershipRoleChangeAction
  | MembershipRevocationAction
  | DeviceAuthorizationAction
  | DeviceRevocationAction
  | ActiveControlDeviceTransferAction
  | KeyEpochTransitionAction
  | Hc2InvitationCreateAction
  | Hc2InvitationCancelAction
  | Hc2MembershipEpochTransitionAction
  | RootRecoveryAction;

export type ControlActionRecord = Readonly<{
  record_version: 1;
  object_kind: "control_action";
  action_id: ControlActionId;
  core: ControlActionCore;
}>;

export type ControlGenesisCore = Readonly<{
  schema_version: typeof CONTROL_EVENT_CORE_SCHEMA_VERSION;
  object_kind: "control_event_core";
  control_kind: "genesis";
  project_id: ProjectId;
  control_sequence: UInt64;
  previous_control_id: null;
  root_sequence: UInt64;
  previous_root_control_id: null;
  owner_person_id: PersonId;
  offline_root_key_id: PublicKeyId;
  initial_active_control_device_id: DeviceId;
  initial_memberships: readonly InitialMembership[];
  initial_authorized_devices: readonly InitialAuthorizedDevice[];
  initial_key_epoch_id: KeyEpochId;
  initial_key_epoch_commitment: KeyEpochCommitmentId;
  resulting_control_state_root: ControlStateRootId;
  display_timestamp?: NonAuthoritativeTimestamp;
}>;

export type OrdinaryControlEventCore = Readonly<{
  schema_version: typeof CONTROL_EVENT_CORE_SCHEMA_VERSION;
  object_kind: "control_event_core";
  control_kind: "ordinary";
  project_id: ProjectId;
  control_sequence: UInt64;
  previous_control_id: ControlEventId;
  issuer_device_id: DeviceId;
  action_id: ControlActionId;
  resulting_control_state_root: ControlStateRootId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  display_timestamp?: NonAuthoritativeTimestamp;
}>;

export type RootRecoveryControlEventCore = Readonly<{
  schema_version: typeof CONTROL_EVENT_CORE_SCHEMA_VERSION;
  object_kind: "control_event_core";
  control_kind: "root_recovery";
  project_id: ProjectId;
  control_sequence: UInt64;
  previous_control_id: ControlEventId;
  root_sequence: UInt64;
  previous_root_control_id: ControlEventId;
  issuer_root_key_id: PublicKeyId;
  action_id: ControlActionId;
  resulting_control_state_root: ControlStateRootId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  display_timestamp?: NonAuthoritativeTimestamp;
}>;

export type ControlEventCore =
  | ControlGenesisCore
  | OrdinaryControlEventCore
  | RootRecoveryControlEventCore;

export type ControlEventRecord = Readonly<{
  record_version: typeof CONTROL_EVENT_RECORD_VERSION;
  object_kind: "control_event";
  control_event_id: ControlEventId;
  core: ControlEventCore;
  authority_attestation_id: AttestationId;
}>;

export type OrdinaryControlValidationContext = Readonly<{
  expected_previous_control_id: ControlEventId;
  expected_control_sequence: UInt64;
  designated_active_control_device_id: DeviceId;
  expected_project_id: ProjectId;
}>;

export type DerivedControlForkRecord = Readonly<{
  schema_version: typeof DERIVED_CONFLICT_SCHEMA_VERSION;
  object_kind: "derived_control_fork";
  authority: "none";
  quarantine_state: "control_projection_frozen";
  conflict_id: DerivedConflictId;
  project_id: ProjectId;
  last_uncontested_control_id: ControlEventId;
  conflicting_tip_ids: readonly ControlEventId[];
}>;

export function parseControlActionCore(value: unknown): ControlActionCore {
  const discriminator = expectExactRecord(
    value,
    "control action core",
    ["schema_version", "project_id", "action_kind"],
    [
      "membership_id",
      "person_id",
      "role",
      "access_scope_id",
      "next_role",
      "revocation_cutoffs",
      "device_id",
      "signing_key_id",
      "semantic_sequence_cutoff",
      "previous_active_control_device_id",
      "replacement_active_control_device_id",
      "previous_key_epoch_id",
      "replacement_key_epoch_id",
      "replacement_key_epoch_commitment",
      "reason",
      "invitation_id",
      "inviting_membership_id",
      "inviting_person_id",
      "inviting_device_id",
      "intended_role",
      "access_scope",
      "creation_control_head_id",
      "valid_through_control_sequence",
      "invitation_control_event_id",
      "transition_id",
      "transition_kind",
      "recipient_manifest_id",
      "delivery_set_id",
      "suite_id",
      "last_uncontested_control_id",
      "selected_membership_device_state_root",
      "revocation_sequence_cutoffs",
      "observed_conflicting_tip_ids",
      "supersession_policy"
    ]
  );
  expectLiteral(
    discriminator.schema_version,
    CONTROL_ACTION_SCHEMA_VERSION,
    "control action schema version"
  );
  const projectId = parseEntityId("project", discriminator.project_id);
  const kind = expectEnum(
    discriminator.action_kind,
    [
      "membership_grant",
      "membership_role_change",
      "membership_revocation",
      "device_authorization",
      "device_revocation",
      "active_control_device_transfer",
      "key_epoch_transition",
      "hc2_invitation_create",
      "hc2_invitation_cancel",
      "hc2_membership_epoch_transition",
      "root_recovery"
    ] as const,
    "control action kind"
  );
  switch (kind) {
    case "membership_grant":
      requireVariantKeys(discriminator, [
        "membership_id",
        "person_id",
        "role",
        "access_scope_id"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        membership_id: parseEntityId("membership", discriminator.membership_id),
        person_id: parseEntityId("person", discriminator.person_id),
        role: parseRole(discriminator.role),
        access_scope_id: parseEntityId(
          "access-scope",
          discriminator.access_scope_id
        )
      });
    case "membership_role_change":
      requireVariantKeys(discriminator, [
        "membership_id",
        "person_id",
        "next_role"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        membership_id: parseEntityId("membership", discriminator.membership_id),
        person_id: parseEntityId("person", discriminator.person_id),
        next_role: parseRole(discriminator.next_role)
      });
    case "membership_revocation":
      requireVariantKeys(discriminator, [
        "membership_id",
        "person_id",
        "revocation_cutoffs"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        membership_id: parseEntityId("membership", discriminator.membership_id),
        person_id: parseEntityId("person", discriminator.person_id),
        revocation_cutoffs: parseDeviceSequenceCutoffs(
          discriminator.revocation_cutoffs,
          "membership revocation cutoffs"
        )
      });
    case "device_authorization":
      requireVariantKeys(discriminator, [
        "person_id",
        "device_id",
        "signing_key_id"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        person_id: parseEntityId("person", discriminator.person_id),
        device_id: parseEntityId("device", discriminator.device_id),
        signing_key_id: parseEntityId("public-key", discriminator.signing_key_id)
      });
    case "device_revocation":
      requireVariantKeys(discriminator, [
        "person_id",
        "device_id",
        "semantic_sequence_cutoff"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        person_id: parseEntityId("person", discriminator.person_id),
        device_id: parseEntityId("device", discriminator.device_id),
        semantic_sequence_cutoff: expectUInt64(
          discriminator.semantic_sequence_cutoff,
          "device revocation sequence cutoff"
        )
      });
    case "active_control_device_transfer":
      requireVariantKeys(discriminator, [
        "previous_active_control_device_id",
        "replacement_active_control_device_id"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        previous_active_control_device_id: parseEntityId(
          "device",
          discriminator.previous_active_control_device_id
        ),
        replacement_active_control_device_id: parseEntityId(
          "device",
          discriminator.replacement_active_control_device_id
        )
      });
    case "key_epoch_transition":
      requireVariantKeys(discriminator, [
        "previous_key_epoch_id",
        "replacement_key_epoch_id",
        "replacement_key_epoch_commitment",
        "reason"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        previous_key_epoch_id: parseEntityId(
          "key-epoch",
          discriminator.previous_key_epoch_id
        ),
        replacement_key_epoch_id: parseEntityId(
          "key-epoch",
          discriminator.replacement_key_epoch_id
        ),
        replacement_key_epoch_commitment: parseDigestId(
          "key-epoch-commitment",
          discriminator.replacement_key_epoch_commitment
        ),
        reason: expectEnum(
          discriminator.reason,
          ["membership_change", "device_revocation", "periodic_rotation"] as const,
          "key epoch transition reason"
        )
      });
    case "hc2_invitation_create":
      requireVariantKeys(discriminator, [
        "invitation_id",
        "inviting_membership_id",
        "inviting_person_id",
        "inviting_device_id",
        "intended_role",
        "access_scope",
        "access_scope_id",
        "creation_control_head_id",
        "valid_through_control_sequence",
        "suite_id"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        invitation_id: parseEntityId("invitation", discriminator.invitation_id),
        inviting_membership_id: parseEntityId("membership", discriminator.inviting_membership_id),
        inviting_person_id: parseEntityId("person", discriminator.inviting_person_id),
        inviting_device_id: parseEntityId("device", discriminator.inviting_device_id),
        intended_role: parseRole(discriminator.intended_role),
        access_scope: expectLiteral(discriminator.access_scope, "project_wide", "HC-2 invitation access scope"),
        access_scope_id: parseEntityId("access-scope", discriminator.access_scope_id),
        creation_control_head_id: parseDigestId("control-event", discriminator.creation_control_head_id),
        valid_through_control_sequence: expectUInt64(discriminator.valid_through_control_sequence, "invitation validity control sequence"),
        suite_id: expectLiteral(discriminator.suite_id, "patchmark/hc2/crypto-suite/v1", "HC-2 invitation suite")
      });
    case "hc2_invitation_cancel":
      requireVariantKeys(discriminator, ["invitation_id", "invitation_control_event_id", "suite_id"]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        invitation_id: parseEntityId("invitation", discriminator.invitation_id),
        invitation_control_event_id: parseDigestId("control-event", discriminator.invitation_control_event_id),
        suite_id: expectLiteral(discriminator.suite_id, "patchmark/hc2/crypto-suite/v1", "HC-2 invitation suite")
      });
    case "hc2_membership_epoch_transition":
      requireVariantKeys(discriminator, [
        "transition_id",
        "transition_kind",
        "recipient_manifest_id",
        "delivery_set_id",
        "previous_key_epoch_id",
        "replacement_key_epoch_id",
        "replacement_key_epoch_commitment",
        "replacement_active_control_device_id",
        "suite_id"
      ]);
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        transition_id: parseHc2ControlDigestReference("membership-transition", discriminator.transition_id),
        transition_kind: expectEnum(discriminator.transition_kind, ["new_membership", "additional_device", "role_change", "device_revocation", "membership_revocation"] as const, "HC-2 transition kind"),
        recipient_manifest_id: parseHc2ControlDigestReference("recipient-manifest", discriminator.recipient_manifest_id),
        delivery_set_id: parseHc2ControlDigestReference("delivery-set", discriminator.delivery_set_id),
        previous_key_epoch_id: parseEntityId("key-epoch", discriminator.previous_key_epoch_id),
        replacement_key_epoch_id: parseEntityId("key-epoch", discriminator.replacement_key_epoch_id),
        replacement_key_epoch_commitment: parseDigestId("key-epoch-commitment", discriminator.replacement_key_epoch_commitment),
        replacement_active_control_device_id: parseEntityId("device", discriminator.replacement_active_control_device_id),
        suite_id: expectLiteral(discriminator.suite_id, "patchmark/hc2/crypto-suite/v1", "HC-2 transition suite")
      });
    case "root_recovery":
      requireVariantKeys(discriminator, [
        "last_uncontested_control_id",
        "selected_membership_device_state_root",
        "revocation_sequence_cutoffs",
        "replacement_active_control_device_id",
        "replacement_key_epoch_id",
        "replacement_key_epoch_commitment",
        "observed_conflicting_tip_ids",
        "supersession_policy"
      ]);
      expectLiteral(
        discriminator.supersession_policy,
        "supersede_all_ordinary_descendants_outside_recovery_chain",
        "root recovery supersession policy"
      );
      return freezeRecord({
        schema_version: CONTROL_ACTION_SCHEMA_VERSION,
        project_id: projectId,
        action_kind: kind,
        last_uncontested_control_id: parseDigestId(
          "control-event",
          discriminator.last_uncontested_control_id
        ),
        selected_membership_device_state_root: parseDigestId(
          "control-state-root",
          discriminator.selected_membership_device_state_root
        ),
        revocation_sequence_cutoffs: parseDeviceSequenceCutoffs(
          discriminator.revocation_sequence_cutoffs,
          "root recovery cutoffs"
        ),
        replacement_active_control_device_id: parseEntityId(
          "device",
          discriminator.replacement_active_control_device_id
        ),
        replacement_key_epoch_id: parseEntityId(
          "key-epoch",
          discriminator.replacement_key_epoch_id
        ),
        replacement_key_epoch_commitment: parseDigestId(
          "key-epoch-commitment",
          discriminator.replacement_key_epoch_commitment
        ),
        observed_conflicting_tip_ids: parseSortedUniqueArray(
          discriminator.observed_conflicting_tip_ids,
          "root recovery conflicting tips",
          (candidate) => parseDigestId("control-event", candidate)
        ),
        supersession_policy:
          "supersede_all_ordinary_descendants_outside_recovery_chain" as const
      });
  }
}

export function parseControlActionRecord(value: unknown): ControlActionRecord {
  const record = expectExactRecord(value, "control action record", [
    "record_version",
    "object_kind",
    "action_id",
    "core"
  ]);
  expectLiteral(record.record_version, 1, "control action record version");
  expectLiteral(
    record.object_kind,
    "control_action",
    "control action object kind"
  );
  return freezeRecord({
    record_version: 1,
    object_kind: "control_action" as const,
    action_id: parseDigestId("control-action", record.action_id),
    core: parseControlActionCore(record.core)
  });
}

/**
 * Parses the immutable control-event core without assuming that its action or
 * predecessor-derived authority context has arrived. Acceptance paths must use
 * parseControlEventCore, which retains the dependency-aware requirements.
 */
export function parseControlEventCoreStructure(
  value: unknown,
  options: {
    action?: ControlActionRecord;
    ordinary_context?: OrdinaryControlValidationContext;
  } = {}
): ControlEventCore {
  const discriminator = expectExactRecord(
    value,
    "control event core",
    [
      "schema_version",
      "object_kind",
      "control_kind",
      "project_id",
      "control_sequence",
      "previous_control_id",
      "resulting_control_state_root"
    ],
    [
      "root_sequence",
      "previous_root_control_id",
      "owner_person_id",
      "offline_root_key_id",
      "initial_active_control_device_id",
      "initial_memberships",
      "initial_authorized_devices",
      "initial_key_epoch_id",
      "initial_key_epoch_commitment",
      "issuer_device_id",
      "issuer_root_key_id",
      "action_id",
      "key_epoch_id",
      "key_epoch_commitment",
      "display_timestamp"
    ]
  );
  expectLiteral(
    discriminator.schema_version,
    CONTROL_EVENT_CORE_SCHEMA_VERSION,
    "control event core schema version"
  );
  expectLiteral(
    discriminator.object_kind,
    "control_event_core",
    "control event core object kind"
  );
  const kind = expectEnum(
    discriminator.control_kind,
    ["genesis", "ordinary", "root_recovery"] as const,
    "control event kind"
  );
  const projectId = parseEntityId("project", discriminator.project_id);
  const stateRoot = parseDigestId(
    "control-state-root",
    discriminator.resulting_control_state_root
  );
  const displayTimestamp =
    discriminator.display_timestamp === undefined
      ? undefined
      : expectDisplayTimestamp(
          discriminator.display_timestamp,
          "control event display timestamp"
        );

  if (kind === "genesis") {
    requireEventVariantKeys(discriminator, [
      "root_sequence",
      "previous_root_control_id",
      "owner_person_id",
      "offline_root_key_id",
      "initial_active_control_device_id",
      "initial_memberships",
      "initial_authorized_devices",
      "initial_key_epoch_id",
      "initial_key_epoch_commitment"
    ]);
    expectLiteral(
      discriminator.previous_control_id,
      null,
      "control genesis previous control ID"
    );
    expectLiteral(
      discriminator.previous_root_control_id,
      null,
      "control genesis previous root control ID"
    );
    const ownerPersonId = parseEntityId("person", discriminator.owner_person_id);
    const activeDeviceId = parseEntityId(
      "device",
      discriminator.initial_active_control_device_id
    );
    const memberships = parseInitialMemberships(discriminator.initial_memberships);
    const devices = parseInitialDevices(discriminator.initial_authorized_devices);
    if (
      !memberships.some(
        (membership) =>
          membership.person_id === ownerPersonId && membership.role === "owner"
      )
    ) {
      throw new Error("Control genesis requires an active owner membership.");
    }
    if (
      !devices.some(
        (device) =>
          device.device_id === activeDeviceId && device.person_id === ownerPersonId
      )
    ) {
      throw new Error(
        "The initial active control device must be an authorized owner device."
      );
    }
    return freezeRecord({
      schema_version: CONTROL_EVENT_CORE_SCHEMA_VERSION,
      object_kind: "control_event_core" as const,
      control_kind: "genesis" as const,
      project_id: projectId,
      control_sequence: expectZeroUInt64(
        discriminator.control_sequence,
        "control genesis sequence"
      ),
      previous_control_id: null,
      root_sequence: expectZeroUInt64(
        discriminator.root_sequence,
        "control genesis root sequence"
      ),
      previous_root_control_id: null,
      owner_person_id: ownerPersonId,
      offline_root_key_id: parseEntityId(
        "public-key",
        discriminator.offline_root_key_id
      ),
      initial_active_control_device_id: activeDeviceId,
      initial_memberships: memberships,
      initial_authorized_devices: devices,
      initial_key_epoch_id: parseEntityId(
        "key-epoch",
        discriminator.initial_key_epoch_id
      ),
      initial_key_epoch_commitment: parseDigestId(
        "key-epoch-commitment",
        discriminator.initial_key_epoch_commitment
      ),
      resulting_control_state_root: stateRoot,
      ...(displayTimestamp ? { display_timestamp: displayTimestamp } : {})
    });
  }

  if (kind === "ordinary") {
    requireEventVariantKeys(discriminator, [
      "issuer_device_id",
      "action_id",
      "key_epoch_id",
      "key_epoch_commitment"
    ]);
    const ordinary = freezeRecord({
      schema_version: CONTROL_EVENT_CORE_SCHEMA_VERSION,
      object_kind: "control_event_core" as const,
      control_kind: "ordinary" as const,
      project_id: projectId,
      control_sequence: expectPositiveUInt64(
        discriminator.control_sequence,
        "ordinary control sequence"
      ),
      previous_control_id: parseDigestId(
        "control-event",
        discriminator.previous_control_id
      ),
      issuer_device_id: parseEntityId("device", discriminator.issuer_device_id),
      action_id: parseDigestId("control-action", discriminator.action_id),
      resulting_control_state_root: stateRoot,
      key_epoch_id: parseEntityId("key-epoch", discriminator.key_epoch_id),
      key_epoch_commitment: parseDigestId(
        "key-epoch-commitment",
        discriminator.key_epoch_commitment
      ),
      ...(displayTimestamp ? { display_timestamp: displayTimestamp } : {})
    });
    if (options.ordinary_context) {
      assertOrdinaryControlContext(ordinary, options.ordinary_context);
    }
    if (options.action) {
      assertControlActionMatch(ordinary, options.action, false);
    }
    return ordinary;
  }

  requireEventVariantKeys(discriminator, [
    "root_sequence",
    "previous_root_control_id",
    "issuer_root_key_id",
    "action_id",
    "key_epoch_id",
    "key_epoch_commitment"
  ]);
  const recovery = freezeRecord({
    schema_version: CONTROL_EVENT_CORE_SCHEMA_VERSION,
    object_kind: "control_event_core" as const,
    control_kind: "root_recovery" as const,
    project_id: projectId,
    control_sequence: expectPositiveUInt64(
      discriminator.control_sequence,
      "root recovery control sequence"
    ),
    previous_control_id: parseDigestId(
      "control-event",
      discriminator.previous_control_id
    ),
    root_sequence: expectPositiveUInt64(
      discriminator.root_sequence,
      "root recovery root sequence"
    ),
    previous_root_control_id: parseDigestId(
      "control-event",
      discriminator.previous_root_control_id
    ),
    issuer_root_key_id: parseEntityId(
      "public-key",
      discriminator.issuer_root_key_id
    ),
    action_id: parseDigestId("control-action", discriminator.action_id),
    resulting_control_state_root: stateRoot,
    key_epoch_id: parseEntityId("key-epoch", discriminator.key_epoch_id),
    key_epoch_commitment: parseDigestId(
      "key-epoch-commitment",
      discriminator.key_epoch_commitment
    ),
    ...(displayTimestamp ? { display_timestamp: displayTimestamp } : {})
  });
  if (options.action) {
    assertControlActionMatch(recovery, options.action, true);
  }
  return recovery;
}

export function parseControlEventCore(
  value: unknown,
  options: {
    action?: ControlActionRecord;
    ordinary_context?: OrdinaryControlValidationContext;
  } = {}
): ControlEventCore {
  const core = parseControlEventCoreStructure(value, options);
  if (core.control_kind === "ordinary" && !options.ordinary_context) {
    throw new Error(
      "Ordinary control events require designated active-control-device context."
    );
  }
  if (core.control_kind === "root_recovery" && !options.action) {
    throw new Error("Root recovery events require their root-recovery action.");
  }
  return core;
}

export function parseControlEventRecord(
  value: unknown,
  options: {
    action?: ControlActionRecord;
    ordinary_context?: OrdinaryControlValidationContext;
  } = {}
): ControlEventRecord {
  const parsed = parseControlEventRecordStructure(value);
  parseControlEventCore(parsed.core, options);
  return parsed;
}

export function parseControlEventRecordStructure(
  value: unknown
): ControlEventRecord {
  const record = expectExactRecord(value, "control event record", [
    "record_version",
    "object_kind",
    "control_event_id",
    "core",
    "authority_attestation_id"
  ]);
  expectLiteral(
    record.record_version,
    CONTROL_EVENT_RECORD_VERSION,
    "control event record version"
  );
  expectLiteral(record.object_kind, "control_event", "control event object kind");
  const eventId = parseDigestId("control-event", record.control_event_id);
  const core = parseControlEventCoreStructure(record.core);
  if (
    core.previous_control_id === eventId ||
    (core.control_kind !== "ordinary" &&
      core.previous_root_control_id === eventId)
  ) {
    throw new Error("A control event cannot reference itself.");
  }
  return freezeRecord({
    record_version: CONTROL_EVENT_RECORD_VERSION,
    object_kind: "control_event" as const,
    control_event_id: eventId,
    core,
    authority_attestation_id: parseDigestId(
      "attestation",
      record.authority_attestation_id
    )
  });
}

export function parseDerivedControlForkRecord(
  value: unknown
): DerivedControlForkRecord {
  const record = expectExactRecord(value, "derived control fork", [
    "schema_version",
    "object_kind",
    "authority",
    "quarantine_state",
    "conflict_id",
    "project_id",
    "last_uncontested_control_id",
    "conflicting_tip_ids"
  ]);
  expectLiteral(
    record.schema_version,
    DERIVED_CONFLICT_SCHEMA_VERSION,
    "control fork schema version"
  );
  expectLiteral(
    record.object_kind,
    "derived_control_fork",
    "control fork object kind"
  );
  expectLiteral(record.authority, "none", "control fork authority");
  expectLiteral(
    record.quarantine_state,
    "control_projection_frozen",
    "control fork quarantine state"
  );
  const tips = parseSortedUniqueArray(
    record.conflicting_tip_ids,
    "control fork tips",
    (candidate) => parseDigestId("control-event", candidate)
  );
  if (tips.length < 2) {
    throw new Error("A control fork requires at least two conflicting tips.");
  }
  return freezeRecord({
    schema_version: DERIVED_CONFLICT_SCHEMA_VERSION,
    object_kind: "derived_control_fork" as const,
    authority: "none" as const,
    quarantine_state: "control_projection_frozen" as const,
    conflict_id: parseDigestId("derived-conflict", record.conflict_id),
    project_id: parseEntityId("project", record.project_id),
    last_uncontested_control_id: parseDigestId(
      "control-event",
      record.last_uncontested_control_id
    ),
    conflicting_tip_ids: tips
  });
}

function assertOrdinaryControlContext(
  core: OrdinaryControlEventCore,
  context: OrdinaryControlValidationContext
): void {
  if (core.project_id !== context.expected_project_id) {
    throw new Error("Ordinary control event belongs to another project.");
  }
  if (core.previous_control_id !== context.expected_previous_control_id) {
    throw new Error("Ordinary control event does not extend the current control head.");
  }
  if (core.control_sequence !== context.expected_control_sequence) {
    throw new Error("Ordinary control event does not have the required next sequence.");
  }
  if (core.issuer_device_id !== context.designated_active_control_device_id) {
    throw new Error(
      "Ordinary control event was not issued by the designated active control device."
    );
  }
}

function assertControlActionMatch(
  core: OrdinaryControlEventCore | RootRecoveryControlEventCore,
  action: ControlActionRecord,
  requireRecovery: boolean
): void {
  if (core.project_id !== action.core.project_id || core.action_id !== action.action_id) {
    throw new Error("Control event and action identity must match.");
  }
  if (requireRecovery !== (action.core.action_kind === "root_recovery")) {
    throw new Error(
      requireRecovery
        ? "Root recovery event requires a root-recovery action."
        : "An ordinary control event cannot carry a root-recovery action."
    );
  }
  if (
    requireRecovery &&
    action.core.action_kind === "root_recovery" &&
    (core.previous_control_id !== action.core.last_uncontested_control_id ||
      core.key_epoch_id !== action.core.replacement_key_epoch_id ||
      core.key_epoch_commitment !==
        action.core.replacement_key_epoch_commitment)
  ) {
    throw new Error("Root recovery event does not match its selected recovery state.");
  }
}

function parseInitialMemberships(value: unknown): readonly InitialMembership[] {
  return parseUniqueArray(
    value,
    "initial memberships",
    (candidate) => {
      const record = expectExactRecord(candidate, "initial membership", [
        "membership_id",
        "person_id",
        "role",
        "access_scope_id",
        "status"
      ]);
      expectLiteral(record.status, "active", "initial membership status");
      return freezeRecord({
        membership_id: parseEntityId("membership", record.membership_id),
        person_id: parseEntityId("person", record.person_id),
        role: parseRole(record.role),
        access_scope_id: parseEntityId("access-scope", record.access_scope_id),
        status: "active" as const
      });
    },
    (candidate) => candidate.membership_id,
    { requireSorted: true }
  );
}

function parseInitialDevices(value: unknown): readonly InitialAuthorizedDevice[] {
  return parseUniqueArray(
    value,
    "initial authorized devices",
    (candidate) => {
      const record = expectExactRecord(candidate, "initial authorized device", [
        "device_id",
        "person_id",
        "signing_key_id",
        "status"
      ]);
      expectLiteral(record.status, "active", "initial device status");
      return freezeRecord({
        device_id: parseEntityId("device", record.device_id),
        person_id: parseEntityId("person", record.person_id),
        signing_key_id: parseEntityId("public-key", record.signing_key_id),
        status: "active" as const
      });
    },
    (candidate) => candidate.device_id,
    { requireSorted: true }
  );
}

function parseDeviceSequenceCutoffs(
  value: unknown,
  label: string
): readonly DeviceSequenceCutoff[] {
  return parseUniqueArray(
    value,
    label,
    (candidate) => {
      const record = expectExactRecord(candidate, "device sequence cutoff", [
        "device_id",
        "maximum_accepted_semantic_sequence"
      ]);
      return freezeRecord({
        device_id: parseEntityId("device", record.device_id),
        maximum_accepted_semantic_sequence: expectUInt64(
          record.maximum_accepted_semantic_sequence,
          "maximum accepted semantic sequence"
        )
      });
    },
    (candidate) => candidate.device_id,
    { allowEmpty: true, requireSorted: true }
  );
}

function parseRole(value: unknown): CollaborationRole {
  return expectEnum(value, collaborationRoles, "collaboration role");
}

const actionBaseKeys = new Set(["schema_version", "project_id", "action_kind"]);

function requireVariantKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  const allowed = new Set([...actionBaseKeys, ...keys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Control action ${record.action_kind} cannot contain ${key}.`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Control action ${record.action_kind} requires ${key}.`);
    }
  }
}

function parseHc2ControlDigestReference(kind: "membership-transition" | "recipient-manifest" | "delivery-set", value: unknown): string {
  if (typeof value !== "string") throw new Error(`${kind} reference must be a string.`);
  const prefix = `pm:${kind}:v1:`;
  if (!value.startsWith(prefix)) throw new Error(`${kind} reference uses the wrong namespace.`);
  try { decodeSha256Base32(value.slice(prefix.length)); }
  catch { throw new Error(`${kind} reference must use canonical lowercase SHA-256 Base32.`); }
  return value;
}

const eventBaseKeys = new Set([
  "schema_version",
  "object_kind",
  "control_kind",
  "project_id",
  "control_sequence",
  "previous_control_id",
  "resulting_control_state_root",
  "display_timestamp"
]);

function requireEventVariantKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  const allowed = new Set([...eventBaseKeys, ...keys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Control event ${record.control_kind} cannot contain ${key}.`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Control event ${record.control_kind} requires ${key}.`);
    }
  }
}

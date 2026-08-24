import { encodeCanonicalCbor } from "../canonical-cbor.ts";
import type {
  ControlGenesisCore,
  RootRecoveryControlEventCore
} from "../control.ts";
import {
  parseControlEventCoreStructure
} from "../control.ts";
import {
  parseDigestId,
  parseEntityId,
  type AccessScopeId,
  type ControlEventId,
  type DeviceId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type PersonId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import {
  buildSignaturePreimage,
  deriveControlEventCoreIdentity
} from "../preimages.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  DeviceKekHandle,
  DeviceSigningPrivateKeyHandle,
  X25519RecipientKeyPairHandle
} from "./crypto-contracts.ts";

declare const rootAuthorityPreimageBrand: unique symbol;
declare const preparedCustodyBrand: unique symbol;

export type RootAuthorityPurpose = "initial_foundation" | "root_recovery";

export type RootAuthorityPreimage<TPurpose extends RootAuthorityPurpose = RootAuthorityPurpose> = Readonly<{
  purpose: TPurpose;
  project_id: ProjectId;
  control_event_id: ControlEventId;
  root_key_id: PublicKeyId;
  exact_bytes: Uint8Array;
  readonly [rootAuthorityPreimageBrand]: TPurpose;
}>;

const constructedRootPreimages = new WeakSet<object>();

export async function buildInitialFoundationRootPreimage(
  value: ControlGenesisCore
): Promise<RootAuthorityPreimage<"initial_foundation">> {
  const core = parseControlEventCoreStructure(value);
  if (core.control_kind !== "genesis") throw new Error("Initial root authority requires a control genesis core.");
  const identity = await deriveControlEventCoreIdentity(core);
  return rootPreimage("initial_foundation", core.project_id, identity.id, core.offline_root_key_id);
}

export async function buildRootRecoveryAuthorityPreimage(
  value: RootRecoveryControlEventCore
): Promise<RootAuthorityPreimage<"root_recovery">> {
  const core = parseControlEventCoreStructure(value);
  if (core.control_kind !== "root_recovery") throw new Error("Root recovery authority requires a root-recovery control core.");
  const identity = await deriveControlEventCoreIdentity(core);
  return rootPreimage("root_recovery", core.project_id, identity.id, core.issuer_root_key_id);
}

export function isConstructedRootAuthorityPreimage(value: unknown): value is RootAuthorityPreimage {
  return typeof value === "object" && value !== null && constructedRootPreimages.has(value);
}

function rootPreimage<TPurpose extends RootAuthorityPurpose>(
  purpose: TPurpose,
  projectId: ProjectId,
  controlEventId: ControlEventId,
  rootKeyId: PublicKeyId
): RootAuthorityPreimage<TPurpose> {
  const project = parseEntityId("project", projectId);
  const event = parseDigestId("control-event", controlEventId);
  const key = parseEntityId("public-key", rootKeyId);
  const value = Object.freeze({
    purpose,
    project_id: project,
    control_event_id: event,
    root_key_id: key,
    exact_bytes: Uint8Array.from(encodeCanonicalCbor(buildSignaturePreimage("control_event", project, event)))
  }) as RootAuthorityPreimage<TPurpose>;
  constructedRootPreimages.add(value);
  return value;
}

export type DeviceCustodyPublicBinding = Readonly<{
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  access_scope_id: AccessScopeId;
  generation: bigint;
  signing_key_id: PublicKeyId;
  signing_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  recipient_key_id: PublicKeyId;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  accepted_control_head_id: ControlEventId;
  offline_root_key_id: PublicKeyId;
  current_epoch_id: KeyEpochId;
  current_epoch_commitment: KeyEpochCommitmentId;
  current_epoch_public_commitment_bytes: Uint8Array;
}>;

export type LoadedDeviceCustody = Readonly<{
  public_binding: DeviceCustodyPublicBinding;
  signing_key: DeviceSigningPrivateKeyHandle;
  recipient_key_pair: X25519RecipientKeyPairHandle;
  local_kek: DeviceKekHandle;
}>;

export type PreparedDeviceCustodyHandle = Readonly<{
  handle_kind: "prepared_device_custody";
  project_id: ProjectId;
  device_id: DeviceId;
  readonly [preparedCustodyBrand]: true;
}>;

export type AcceptedCustodyAuthority = Readonly<{
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  access_scope_id: AccessScopeId;
  signing_key_id: PublicKeyId;
  recipient_key_id: PublicKeyId;
  accepted_control_head_id: ControlEventId;
  offline_root_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  device_status: "active";
}>;

export function parseAcceptedCustodyAuthority(value: AcceptedCustodyAuthority): AcceptedCustodyAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Accepted custody authority must be a record.");
  const expected = [
    "project_id", "person_id", "device_id", "access_scope_id", "signing_key_id", "recipient_key_id",
    "accepted_control_head_id", "offline_root_key_id", "key_epoch_id", "key_epoch_commitment", "device_status"
  ].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Accepted custody authority must contain exactly the versioned fields.");
  }
  if (value.device_status !== "active") throw new Error("Only accepted active device authority can open custody.");
  return Object.freeze({
    project_id: parseEntityId("project", value.project_id),
    person_id: parseEntityId("person", value.person_id),
    device_id: parseEntityId("device", value.device_id),
    access_scope_id: parseEntityId("access-scope", value.access_scope_id),
    signing_key_id: parseEntityId("public-key", value.signing_key_id),
    recipient_key_id: parseEntityId("public-key", value.recipient_key_id),
    accepted_control_head_id: parseDigestId("control-event", value.accepted_control_head_id),
    offline_root_key_id: parseEntityId("public-key", value.offline_root_key_id),
    key_epoch_id: parseEntityId("key-epoch", value.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", value.key_epoch_commitment),
    device_status: "active"
  });
}

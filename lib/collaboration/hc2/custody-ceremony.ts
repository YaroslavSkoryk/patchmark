import { canonicalArray, canonicalText, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import {
  parseControlActionCore,
  parseControlEventCoreStructure,
  type ControlGenesisCore,
  type DeviceSequenceCutoff,
  type RootRecoveryAction,
  type RootRecoveryControlEventCore
} from "../control.ts";
import {
  parseDigestId,
  parseEntityId,
  type AccessScopeId,
  type ControlEventId,
  type ControlStateRootId,
  type DeviceId,
  type KeyEpochId,
  type PersonId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import { deriveControlActionIdentity, deriveControlEventCoreIdentity } from "../preimages.ts";
import { sha256 } from "../sha256.ts";
import { expectUInt64 } from "../validation.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  RecoveryCeremonyCapability,
  RootCeremonyCapability,
  SenderSignaturePreimageBytes
} from "./crypto-contracts.ts";
import {
  buildInitialFoundationRootPreimage,
  buildRootRecoveryAuthorityPreimage,
  parseAcceptedCustodyAuthority,
  type AcceptedCustodyAuthority,
  type DeviceCustodyPublicBinding,
  type LoadedDeviceCustody
} from "./custody-types.ts";
import {
  parseCustodyCeremonyJournal,
  parseStoredDeviceVaultRecord,
  type CustodyCeremonyJournal,
  type CustodyCompletionMarker,
  type Hc2CustodyStore,
  type StoredDeviceVaultRecord
} from "./custody-store.ts";
import { Hc2DeviceVaultService } from "./device-vault.ts";
import { decodeRecoveryKitContainer } from "./recovery-kit-format.ts";
import type { OfflineProjectRootProvider, VerifiedRecoveryKit } from "./providers/root-recovery-provider.ts";
import { HC2_CEREMONY_JOURNAL_VERSION, hc2HashDomains } from "./versions.ts";
import type { Hc2WebLocksAdapter } from "./web-locks.ts";

export const hc2CustodyCeremonyFailureCuts = Object.freeze([
  "after_journal_created",
  "before_recovery_kit_write",
  "after_recovery_kit_write",
  "after_recovery_kit_read",
  "after_recovery_kit_verified",
  "before_device_key_generation",
  "after_device_key_self_tests",
  "before_custody_install",
  "after_custody_install",
  "before_root_authority_signature",
  "after_root_authority_signature",
  "before_portable_commit",
  "after_portable_commit",
  "after_portable_reopen",
  "before_completion_marker"
] as const);

export type Hc2CustodyCeremonyFailureCut = (typeof hc2CustodyCeremonyFailureCuts)[number];

export interface RecoveryKitSink {
  write(ceremonyId: string, exactBytes: Uint8Array): Promise<void>;
  read(ceremonyId: string): Promise<Uint8Array | null>;
}

export type CustodyCeremonyPlan = Readonly<{
  schema_version: typeof HC2_CEREMONY_JOURNAL_VERSION;
  object_kind: "custody_ceremony_plan";
  ceremony_kind: "initial_foundation" | "profile_loss_recovery";
  ceremony_id: string;
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  lost_device_id: DeviceId | null;
  access_scope_id: AccessScopeId;
  vault_generation: bigint;
  signing_key_id: PublicKeyId;
  recipient_key_id: PublicKeyId;
  root_key_id: PublicKeyId;
  root_generation: bigint;
  key_epoch_id: KeyEpochId;
  expected_previous_control_head_id: ControlEventId | null;
}>;

export type DeviceAttestationSigner = (preimage: SenderSignaturePreimageBytes) => Promise<Uint8Array>;

export type InitialFoundationPreparation = Readonly<{
  control_genesis_core: ControlGenesisCore;
  accepted_authority: AcceptedCustodyAuthority;
  commit_portable(input: Readonly<{
    root_signature: Uint8Array;
    custody: LoadedDeviceCustody;
    sign_device: DeviceAttestationSigner;
  }>): Promise<void>;
  reopen_and_verify(): Promise<AcceptedCustodyAuthority>;
}>;

export type VerifiedPortableRecoveryState = Readonly<{
  verification: "verified_complete_batches";
  control_resolution: "single_accepted_root_state";
  project_id: ProjectId;
  accepted_control_head_id: ControlEventId;
  last_uncontested_control_id: ControlEventId;
  previous_root_control_id: ControlEventId;
  root_sequence: bigint;
  offline_root_key_id: PublicKeyId;
  offline_root_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  root_generation: bigint;
  active_control_device_id: DeviceId;
  selected_membership_device_state_root: ControlStateRootId;
  observed_conflicting_tip_ids: readonly ControlEventId[];
  revocation_sequence_cutoffs: readonly DeviceSequenceCutoff[];
}>;

export type RootRecoveryAcceptanceEvidence = Readonly<{
  accepted_authority: AcceptedCustodyAuthority;
  replacement_device_authoritative: true;
  lost_device_superseded: true;
  late_lost_device_evidence: "superseded_control_branch";
  old_private_keys_restored: false;
  old_sequence_continuity_restored: false;
  old_reservations_restored: false;
}>;

export type RootRecoveryPreparation = Readonly<{
  action: RootRecoveryAction;
  control_event_core: RootRecoveryControlEventCore;
  accepted_authority: AcceptedCustodyAuthority;
  commit_portable(input: Readonly<{
    root_signature: Uint8Array;
    custody: LoadedDeviceCustody;
    sign_device: DeviceAttestationSigner;
  }>): Promise<void>;
  reopen_and_verify(): Promise<RootRecoveryAcceptanceEvidence>;
}>;

type CustodyCeremonyFailureResult = Readonly<{ status: "aborted" | "lock_failed" | "failed"; reason: string }>;

export type CustodyCeremonyResult =
  | Readonly<{ status: "complete"; marker: CustodyCompletionMarker; custody: LoadedDeviceCustody; resumed: boolean }>
  | CustodyCeremonyFailureResult;

export type CustodyCeremonyAbandonResult =
  | Readonly<{ status: "abandoned"; journal: CustodyCeremonyJournal }>
  | CustodyCeremonyFailureResult;

export interface Hc2CustodyCeremonyFailureInjector {
  inject(context: Readonly<{ cut: Hc2CustodyCeremonyFailureCut; operation_id?: string }>): void | Promise<void>;
}

export class Hc2SingleCustodyCeremonyFailureInjector implements Hc2CustodyCeremonyFailureInjector {
  readonly #cut: Hc2CustodyCeremonyFailureCut;
  #fired = false;

  constructor(cut: Hc2CustodyCeremonyFailureCut) {
    if (!hc2CustodyCeremonyFailureCuts.includes(cut)) throw new Error("Unknown custody ceremony failure cut.");
    this.#cut = cut;
  }

  inject(context: Readonly<{ cut: Hc2CustodyCeremonyFailureCut }>): void {
    if (!this.#fired && context.cut === this.#cut) {
      this.#fired = true;
      throw new Hc2CustodyCeremonyInjectedFailure(context.cut);
    }
  }

  get fired(): boolean { return this.#fired; }
}

export class Hc2CustodyCeremonyInjectedFailure extends Error {
  readonly cut: Hc2CustodyCeremonyFailureCut;

  constructor(cut: Hc2CustodyCeremonyFailureCut) {
    super(`Injected custody ceremony failure at ${cut}.`);
    this.name = "Hc2CustodyCeremonyInjectedFailure";
    this.cut = cut;
  }
}

export class Hc2CustodyCeremonyCoordinator {
  readonly #store: Hc2CustodyStore;
  readonly #vault: Hc2DeviceVaultService;
  readonly #root: OfflineProjectRootProvider;
  readonly #sink: RecoveryKitSink;
  readonly #locks: Hc2WebLocksAdapter;

  constructor(input: Readonly<{
    store: Hc2CustodyStore;
    vault: Hc2DeviceVaultService;
    root: OfflineProjectRootProvider;
    recovery_kit_sink: RecoveryKitSink;
    locks: Hc2WebLocksAdapter;
  }>) {
    if (!input?.store || !input.vault || !input.root || !input.recovery_kit_sink || !input.locks) {
      throw new Error("Custody ceremonies require all explicit local facilities.");
    }
    this.#store = input.store;
    this.#vault = input.vault;
    this.#root = input.root;
    this.#sink = input.recovery_kit_sink;
    this.#locks = input.locks;
  }

  /** Abandons only a plan that provably cannot have published portable authority. */
  async abandonBeforeCustodyInstall(input: Readonly<{
    plan: CustodyCeremonyPlan;
    signal?: AbortSignal;
  }>): Promise<CustodyCeremonyAbandonResult> {
    let plan: CustodyCeremonyPlan;
    try { plan = parseCustodyCeremonyPlan(input.plan); }
    catch (error) { return failed(error); }
    const locked = await this.#locks.runCustodyCeremonyExclusive({
      project_id: plan.project_id,
      signal: input.signal,
      operation: async (): Promise<CustodyCeremonyAbandonResult> => {
        const journal = await this.#store.readCeremony(plan.project_id, plan.ceremony_id);
        if (!journal || !sameBytes(journal.plan_sha256, await deriveCustodyCeremonyPlanDigest(plan)) ||
            journal.project_id !== plan.project_id || journal.person_id !== plan.person_id || journal.device_id !== plan.device_id ||
            journal.lost_device_id !== plan.lost_device_id || journal.root_key_id !== plan.root_key_id || journal.key_epoch_id !== plan.key_epoch_id) {
          throw new Error("Only the exact stored custody plan may be abandoned.");
        }
        if (journal.phase === "abandoned") return Object.freeze({ status: "abandoned", journal });
        if (journal.phase !== "planned" && journal.phase !== "kit_verified") {
          throw new Error("Custody installation may already have enabled portable authority; exact resume is mandatory.");
        }
        const abandoned = await this.#store.advanceCeremony(journal.phase, parseCustodyCeremonyJournal({ ...journal, phase: "abandoned" }));
        return Object.freeze({ status: "abandoned", journal: abandoned });
      }
    });
    return lockResult(locked);
  }

  async establishInitialFoundation(input: Readonly<{
    plan: CustodyCeremonyPlan;
    root_capability: RootCeremonyCapability;
    recovery_capability: RecoveryCeremonyCapability;
    password_material: Uint8Array;
    validate_source_and_plan(): Promise<void>;
    prepare_foundation(input: Readonly<{
      root: VerifiedRecoveryKit;
      device: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">;
    }>): Promise<InitialFoundationPreparation>;
    signal?: AbortSignal;
    failure_injector?: Hc2CustodyCeremonyFailureInjector;
  }>): Promise<CustodyCeremonyResult> {
    let plan: CustodyCeremonyPlan;
    try {
      plan = parseCustodyCeremonyPlan(input.plan);
      if (plan.ceremony_kind !== "initial_foundation") throw new Error("Initial foundation requires an initial ceremony plan.");
      await input.validate_source_and_plan();
    } catch (error) { return failed(error); }
    const locked = await this.#locks.runCustodyCeremonyExclusive({
      project_id: plan.project_id,
      signal: input.signal,
      operation: async () => this.#runInitial(plan, input)
    });
    return lockResult(locked);
  }

  async recoverAfterProfileLoss(input: Readonly<{
    plan: CustodyCeremonyPlan;
    recovery_capability: RecoveryCeremonyCapability;
    password_material: Uint8Array;
    verify_portable_replica(): Promise<VerifiedPortableRecoveryState>;
    prepare_recovery(input: Readonly<{
      portable: VerifiedPortableRecoveryState;
      root: VerifiedRecoveryKit;
      device: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">;
    }>): Promise<RootRecoveryPreparation>;
    signal?: AbortSignal;
    failure_injector?: Hc2CustodyCeremonyFailureInjector;
  }>): Promise<CustodyCeremonyResult> {
    let plan: CustodyCeremonyPlan;
    try {
      plan = parseCustodyCeremonyPlan(input.plan);
      if (plan.ceremony_kind !== "profile_loss_recovery") throw new Error("Profile-loss recovery requires a recovery ceremony plan.");
    } catch (error) { return failed(error); }
    const locked = await this.#locks.runCustodyCeremonyExclusive({
      project_id: plan.project_id,
      signal: input.signal,
      operation: async () => this.#runRecovery(plan, input)
    });
    return lockResult(locked);
  }

  async #runInitial(
    plan: CustodyCeremonyPlan,
    input: Parameters<Hc2CustodyCeremonyCoordinator["establishInitialFoundation"]>[0]
  ): Promise<CustodyCeremonyResult> {
    const started = await this.#begin(plan);
    if (started.complete) return started.complete;
    await inject(input.failure_injector, "after_journal_created", plan.ceremony_id);
    const verified = await this.#createOrVerifyInitialKit(plan, input);
    const verifiedJournal = await this.#recordKitVerified(started.journal, verified);
    await inject(input.failure_injector, "after_recovery_kit_verified", plan.ceremony_id);
    return this.#installCommitComplete({
      plan,
      started: verifiedJournal,
      resumed: started.resumed,
      verified,
      prepare: input.prepare_foundation,
      password_material: input.password_material,
      recovery_capability: input.recovery_capability,
      signal: input.signal,
      failure_injector: input.failure_injector
    });
  }

  async #runRecovery(
    plan: CustodyCeremonyPlan,
    input: Parameters<Hc2CustodyCeremonyCoordinator["recoverAfterProfileLoss"]>[0]
  ): Promise<CustodyCeremonyResult> {
    const portable = parseVerifiedPortableRecoveryState(await input.verify_portable_replica());
    assertRecoveryPlanState(plan, portable);
    const started = await this.#begin(plan);
    if (started.complete) return started.complete;
    await inject(input.failure_injector, "after_journal_created", plan.ceremony_id);
    const kit = await this.#sink.read(plan.ceremony_id);
    if (!(kit instanceof Uint8Array)) throw new Error("The exact recovery kit is unavailable.");
    await inject(input.failure_injector, "after_recovery_kit_read", plan.ceremony_id);
    const verified = await this.#verifyKit(plan, kit, input.password_material, input.recovery_capability, input.signal);
    if (!sameBytes(verified.root_public_key_bytes, portable.offline_root_public_key_bytes) ||
        verified.root_generation !== portable.root_generation) throw new Error("Recovery kit root does not match accepted portable authority.");
    const verifiedJournal = await this.#recordKitVerified(started.journal, verified);
    await inject(input.failure_injector, "after_recovery_kit_verified", plan.ceremony_id);
    return this.#installCommitComplete({
      plan,
      started: verifiedJournal,
      resumed: started.resumed,
      verified,
      portable,
      prepare: async ({ root, device }) => {
        const prepared = await input.prepare_recovery({ root, device, portable });
        await assertRecoveryTransition(plan, portable, prepared);
        return prepared;
      },
      password_material: input.password_material,
      recovery_capability: input.recovery_capability,
      signal: input.signal,
      failure_injector: input.failure_injector
    });
  }

  async #installCommitComplete(input: Readonly<{
    plan: CustodyCeremonyPlan;
    started: CustodyCeremonyJournal;
    resumed: boolean;
    verified: VerifiedRecoveryKit;
    portable?: VerifiedPortableRecoveryState;
    prepare(value: Readonly<{ root: VerifiedRecoveryKit; device: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id"> }>): Promise<InitialFoundationPreparation | RootRecoveryPreparation>;
    password_material: Uint8Array;
    recovery_capability: RecoveryCeremonyCapability;
    signal?: AbortSignal;
    failure_injector?: Hc2CustodyCeremonyFailureInjector;
  }>): Promise<CustodyCeremonyResult> {
    const { plan } = input;
    let journal = await this.#store.readCeremony(plan.project_id, plan.ceremony_id) ?? input.started;
    assertJournalKit(journal, input.verified);
    let preparedHandle: Awaited<ReturnType<Hc2DeviceVaultService["prepare"]>> | null = null;
    let devicePublic: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">;
    if (journal.phase === "planned" || journal.phase === "kit_verified") {
      await inject(input.failure_injector, "before_device_key_generation", plan.ceremony_id);
      preparedHandle = await this.#vault.prepare({
        project_id: plan.project_id,
        person_id: plan.person_id,
        device_id: plan.device_id,
        access_scope_id: plan.access_scope_id,
        generation: plan.vault_generation,
        signing_key_id: plan.signing_key_id,
        recipient_key_id: plan.recipient_key_id,
        offline_root_key_id: plan.root_key_id,
        key_epoch_id: plan.key_epoch_id,
        recovery_kit_sha256: input.verified.kit_sha256
      });
      devicePublic = preparedHandle.public_binding;
      await inject(input.failure_injector, "after_device_key_self_tests", plan.ceremony_id);
    } else {
      const stored = await this.#store.readVault(plan.project_id, plan.device_id);
      if (!stored) throw new Error("Installed ceremony custody is missing.");
      devicePublic = withoutControl(publicBindingFromVault(parseStoredDeviceVaultRecord(stored)));
    }
    const transition = await input.prepare({ root: input.verified, device: devicePublic });
    const controlCore = transitionControlCore(transition);
    const identity = await deriveControlEventCoreIdentity(controlCore);
    assertTransitionAuthority(plan, input.verified, devicePublic, transition.accepted_authority, identity.id);
    if (journal.phase === "planned" || journal.phase === "kit_verified") {
      const verifiedJournal = parseCustodyCeremonyJournal({
        ...journal,
        recovery_kit_sha256: input.verified.kit_sha256,
        accepted_control_head_id: identity.id,
        phase: "kit_verified"
      });
      if (!preparedHandle) throw new Error("Prepared custody disappeared before installation.");
      await inject(input.failure_injector, "before_custody_install", plan.ceremony_id);
      await this.#vault.install({ handle: preparedHandle.handle, accepted_control_head_id: identity.id, journal: verifiedJournal });
      await inject(input.failure_injector, "after_custody_install", plan.ceremony_id);
      journal = await requireJournal(this.#store, plan);
    } else if (journal.accepted_control_head_id !== identity.id) {
      throw new Error("Ceremony retry attempted to replace the accepted control object.");
    }
    if (journal.phase !== "keys_installed" && journal.phase !== "portable_visible") throw new Error("Ceremony is not resumable from its stored phase.");
    const authority = parseAcceptedCustodyAuthority(transition.accepted_authority);
    const custody = await this.#vault.loadAndVerify(authority);
    const rootPreimage = controlCore.control_kind === "genesis"
      ? await buildInitialFoundationRootPreimage(controlCore)
      : await buildRootRecoveryAuthorityPreimage(controlCore);
    await inject(input.failure_injector, "before_root_authority_signature", plan.ceremony_id);
    const signed = await this.#root.signAuthority({
      capability: input.recovery_capability,
      recovery_kit_bytes: await requireKit(this.#sink, plan.ceremony_id, input.verified.kit_sha256),
      password_material: input.password_material,
      preimage: rootPreimage,
      signal: input.signal
    });
    if (signed.status !== "signed") throw new Error("Offline root authority signature failed.");
    await inject(input.failure_injector, "after_root_authority_signature", plan.ceremony_id);
    if (journal.phase === "keys_installed") {
      await inject(input.failure_injector, "before_portable_commit", plan.ceremony_id);
      await transition.commit_portable({
        root_signature: Uint8Array.from(signed.signature_bytes),
        custody,
        sign_device: async (preimage) => this.#vault.signDevice({ custody, preimage })
      });
      await inject(input.failure_injector, "after_portable_commit", plan.ceremony_id);
      journal = await this.#store.advanceCeremony("keys_installed", parseCustodyCeremonyJournal({ ...journal, phase: "portable_visible" }));
    }
    const reopened = await transition.reopen_and_verify();
    assertReopenEvidence(plan, authority, reopened);
    await inject(input.failure_injector, "after_portable_reopen", plan.ceremony_id);
    await inject(input.failure_injector, "before_completion_marker", plan.ceremony_id);
    const marker = completionMarker(journal);
    await this.#store.writeCompletionMarker(marker);
    return Object.freeze({ status: "complete", marker, custody, resumed: input.resumed });
  }

  async #createOrVerifyInitialKit(
    plan: CustodyCeremonyPlan,
    input: Parameters<Hc2CustodyCeremonyCoordinator["establishInitialFoundation"]>[0]
  ): Promise<VerifiedRecoveryKit> {
    let kit = await this.#sink.read(plan.ceremony_id);
    if (kit === null) {
      const created = await this.#root.create({
        capability: input.root_capability,
        project_id: plan.project_id,
        root_key_id: plan.root_key_id,
        root_generation: plan.root_generation,
        password_material: input.password_material,
        signal: input.signal
      });
      await inject(input.failure_injector, "before_recovery_kit_write", plan.ceremony_id);
      await this.#sink.write(plan.ceremony_id, Uint8Array.from(created.recovery_kit_bytes));
      await inject(input.failure_injector, "after_recovery_kit_write", plan.ceremony_id);
      kit = await this.#sink.read(plan.ceremony_id);
      if (!(kit instanceof Uint8Array) || !sameBytes(kit, created.recovery_kit_bytes)) throw new Error("Recovery-kit sink did not reopen exact written bytes.");
    }
    await inject(input.failure_injector, "after_recovery_kit_read", plan.ceremony_id);
    return this.#verifyKit(plan, kit, input.password_material, input.recovery_capability, input.signal);
  }

  async #recordKitVerified(journal: CustodyCeremonyJournal, root: VerifiedRecoveryKit): Promise<CustodyCeremonyJournal> {
    if (journal.phase === "planned") {
      return this.#store.advanceCeremony("planned", parseCustodyCeremonyJournal({
        ...journal,
        recovery_kit_sha256: root.kit_sha256,
        accepted_control_head_id: null,
        phase: "kit_verified"
      }));
    }
    assertJournalKit(journal, root);
    if (journal.phase === "abandoned") throw new Error("An abandoned custody plan cannot resume.");
    return journal;
  }

  async #verifyKit(plan: CustodyCeremonyPlan, kit: Uint8Array, password: Uint8Array, capability: RecoveryCeremonyCapability, signal?: AbortSignal): Promise<VerifiedRecoveryKit> {
    const container = decodeRecoveryKitContainer(kit);
    if (container.public_header.project_id !== plan.project_id || container.public_header.root_key_id !== plan.root_key_id ||
        container.public_header.root_generation !== plan.root_generation) throw new Error("Recovery-kit public binding differs from the ceremony plan.");
    const verified = await this.#root.verify({ capability, project_id: plan.project_id, root_key_id: plan.root_key_id, recovery_kit_bytes: kit, password_material: password, signal });
    if (verified.status !== "verified") throw new Error("Recovery-kit verification failed.");
    return verified.binding;
  }

  async #begin(plan: CustodyCeremonyPlan): Promise<Readonly<{ journal: CustodyCeremonyJournal; complete: CustodyCeremonyResult | null; resumed: boolean }>> {
    const digest = await deriveCustodyCeremonyPlanDigest(plan);
    const initial = parseCustodyCeremonyJournal({
      schema_version: HC2_CEREMONY_JOURNAL_VERSION,
      record_kind: "custody_ceremony_journal",
      ceremony_kind: plan.ceremony_kind,
      ceremony_id: plan.ceremony_id,
      plan_sha256: digest,
      project_id: plan.project_id,
      person_id: plan.person_id,
      device_id: plan.device_id,
      lost_device_id: plan.lost_device_id,
      root_key_id: plan.root_key_id,
      key_epoch_id: plan.key_epoch_id,
      recovery_kit_sha256: null,
      accepted_control_head_id: null,
      phase: "planned"
    });
    const begun = await this.#store.beginCeremony(initial);
    const journal = begun.journal;
    if (journal.phase === "complete") {
      const marker = await this.#store.readCompletionMarker(plan.project_id, plan.ceremony_id);
      if (!marker) throw new Error("Completed ceremony marker is missing.");
      const stored = await this.#store.readVault(plan.project_id, plan.device_id);
      if (!stored) throw new Error("Completed ceremony custody is missing.");
      const authority = authorityFromVault(parseStoredDeviceVaultRecord(stored));
      const custody = await this.#vault.loadAndVerify(authority);
      return Object.freeze({ journal, complete: Object.freeze({ status: "complete", marker, custody, resumed: true }), resumed: true });
    }
    return Object.freeze({ journal, complete: null, resumed: begun.status === "exact_retry" });
  }
}

export function parseCustodyCeremonyPlan(value: CustodyCeremonyPlan): CustodyCeremonyPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Custody ceremony plan must be a record.");
  const keys = ["schema_version", "object_kind", "ceremony_kind", "ceremony_id", "project_id", "person_id", "device_id", "lost_device_id", "access_scope_id", "vault_generation", "signing_key_id", "recipient_key_id", "root_key_id", "root_generation", "key_epoch_id", "expected_previous_control_head_id"].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error("Custody ceremony plan fields are invalid.");
  if (value.schema_version !== HC2_CEREMONY_JOURNAL_VERSION || value.object_kind !== "custody_ceremony_plan" ||
      (value.ceremony_kind !== "initial_foundation" && value.ceremony_kind !== "profile_loss_recovery") ||
      typeof value.ceremony_id !== "string" || !/^[a-z0-9_.:-]{1,128}$/.test(value.ceremony_id)) throw new Error("Custody ceremony plan metadata is invalid.");
  const lost = value.lost_device_id === null ? null : parseEntityId("device", value.lost_device_id);
  const previous = value.expected_previous_control_head_id === null ? null : parseDigestId("control-event", value.expected_previous_control_head_id);
  if ((value.ceremony_kind === "initial_foundation") !== (lost === null && previous === null)) throw new Error("Ceremony kind, lost device, and previous control head disagree.");
  const device = parseEntityId("device", value.device_id);
  if (lost === device) throw new Error("Profile-loss recovery must allocate a brand-new device identity.");
  return Object.freeze({
    ...value,
    project_id: parseEntityId("project", value.project_id),
    person_id: parseEntityId("person", value.person_id),
    device_id: device,
    lost_device_id: lost,
    access_scope_id: parseEntityId("access-scope", value.access_scope_id),
    vault_generation: expectUInt64(value.vault_generation, "vault generation"),
    signing_key_id: parseEntityId("public-key", value.signing_key_id),
    recipient_key_id: parseEntityId("public-key", value.recipient_key_id),
    root_key_id: parseEntityId("public-key", value.root_key_id),
    root_generation: expectUInt64(value.root_generation, "root generation"),
    key_epoch_id: parseEntityId("key-epoch", value.key_epoch_id),
    expected_previous_control_head_id: previous
  });
}

export async function deriveCustodyCeremonyPlanDigest(value: CustodyCeremonyPlan): Promise<Uint8Array> {
  const plan = parseCustodyCeremonyPlan(value);
  return sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2HashDomains.custodyCeremonyPlan),
    canonicalProtocolValue(plan)
  ])));
}

function parseVerifiedPortableRecoveryState(value: VerifiedPortableRecoveryState): VerifiedPortableRecoveryState {
  if (!value || value.verification !== "verified_complete_batches" || value.control_resolution !== "single_accepted_root_state") throw new Error("Recovery requires a complete verified replica with one accepted root state.");
  requireExactObjectKeys(value, [
    "verification", "control_resolution", "project_id", "accepted_control_head_id", "last_uncontested_control_id",
    "previous_root_control_id", "root_sequence", "offline_root_key_id", "offline_root_public_key_bytes", "root_generation",
    "active_control_device_id", "selected_membership_device_state_root", "observed_conflicting_tip_ids", "revocation_sequence_cutoffs"
  ], "verified portable recovery state");
  const tips = value.observed_conflicting_tip_ids.map((id) => parseDigestId("control-event", id));
  if (tips.some((id, index) => index > 0 && tips[index - 1] >= id)) throw new Error("Observed control tips must be sorted and unique.");
  return Object.freeze({
    ...value,
    project_id: parseEntityId("project", value.project_id),
    accepted_control_head_id: parseDigestId("control-event", value.accepted_control_head_id),
    last_uncontested_control_id: parseDigestId("control-event", value.last_uncontested_control_id),
    previous_root_control_id: parseDigestId("control-event", value.previous_root_control_id),
    root_sequence: expectUInt64(value.root_sequence, "root sequence"),
    offline_root_key_id: parseEntityId("public-key", value.offline_root_key_id),
    offline_root_public_key_bytes: Uint8Array.from(value.offline_root_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    root_generation: expectUInt64(value.root_generation, "root generation"),
    active_control_device_id: parseEntityId("device", value.active_control_device_id),
    selected_membership_device_state_root: parseDigestId("control-state-root", value.selected_membership_device_state_root),
    observed_conflicting_tip_ids: Object.freeze(tips),
    revocation_sequence_cutoffs: Object.freeze(value.revocation_sequence_cutoffs.map((cutoff) => {
      requireExactObjectKeys(cutoff, ["device_id", "maximum_accepted_semantic_sequence"], "recovery sequence cutoff");
      return Object.freeze({
        device_id: parseEntityId("device", cutoff.device_id),
        maximum_accepted_semantic_sequence: expectUInt64(cutoff.maximum_accepted_semantic_sequence, "recovery sequence cutoff")
      });
    }))
  });
}

function assertRecoveryPlanState(plan: CustodyCeremonyPlan, state: VerifiedPortableRecoveryState): void {
  if (plan.project_id !== state.project_id || plan.root_key_id !== state.offline_root_key_id || plan.root_generation !== state.root_generation ||
      plan.expected_previous_control_head_id !== state.accepted_control_head_id || plan.lost_device_id !== state.active_control_device_id ||
      plan.device_id === state.active_control_device_id) throw new Error("Recovery plan differs from verified portable authority.");
}

async function assertRecoveryTransition(plan: CustodyCeremonyPlan, state: VerifiedPortableRecoveryState, value: RootRecoveryPreparation): Promise<void> {
  const action = parseControlActionCore(value.action);
  const actionIdentity = await deriveControlActionIdentity(action);
  const core = parseControlEventCoreStructure(value.control_event_core, { action: { record_version: 1, object_kind: "control_action", action_id: value.control_event_core.action_id, core: action } });
  if (action.action_kind !== "root_recovery" || core.control_kind !== "root_recovery" || action.project_id !== plan.project_id || core.project_id !== plan.project_id ||
      action.last_uncontested_control_id !== state.last_uncontested_control_id || action.selected_membership_device_state_root !== state.selected_membership_device_state_root ||
      action.replacement_active_control_device_id !== plan.device_id || action.replacement_key_epoch_id !== plan.key_epoch_id ||
      core.action_id !== actionIdentity.id || core.previous_control_id !== state.last_uncontested_control_id || core.previous_root_control_id !== state.previous_root_control_id ||
      core.root_sequence !== state.root_sequence + BigInt(1) || core.issuer_root_key_id !== plan.root_key_id || core.key_epoch_id !== plan.key_epoch_id ||
      !sameStrings(action.observed_conflicting_tip_ids, state.observed_conflicting_tip_ids) || !sameCutoffs(action.revocation_sequence_cutoffs, state.revocation_sequence_cutoffs)) {
    throw new Error("Root-recovery action does not exactly bind verified recovery facts.");
  }
}

function assertTransitionAuthority(plan: CustodyCeremonyPlan, root: VerifiedRecoveryKit, device: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">, authorityValue: AcceptedCustodyAuthority, controlId: ControlEventId): void {
  const authority = parseAcceptedCustodyAuthority(authorityValue);
  if (authority.project_id !== plan.project_id || authority.person_id !== plan.person_id || authority.device_id !== plan.device_id || authority.access_scope_id !== plan.access_scope_id ||
      authority.signing_key_id !== plan.signing_key_id || authority.recipient_key_id !== plan.recipient_key_id || authority.accepted_control_head_id !== controlId ||
      authority.offline_root_key_id !== root.root_key_id || authority.key_epoch_id !== plan.key_epoch_id || authority.key_epoch_commitment !== device.current_epoch_commitment) {
    throw new Error("Prepared control authority does not exactly bind generated custody.");
  }
}

function assertJournalKit(journal: CustodyCeremonyJournal, root: VerifiedRecoveryKit): void {
  if (journal.root_key_id !== root.root_key_id || (journal.recovery_kit_sha256 !== null && !sameBytes(journal.recovery_kit_sha256, root.kit_sha256))) throw new Error("Stored ceremony attempted a recovery-kit or root replacement.");
}

function transitionControlCore(value: InitialFoundationPreparation | RootRecoveryPreparation): ControlGenesisCore | RootRecoveryControlEventCore {
  return "control_genesis_core" in value
    ? parseControlEventCoreStructure(value.control_genesis_core) as ControlGenesisCore
    : parseControlEventCoreStructure(value.control_event_core) as RootRecoveryControlEventCore;
}

function assertReopenEvidence(plan: CustodyCeremonyPlan, expected: AcceptedCustodyAuthority, value: AcceptedCustodyAuthority | RootRecoveryAcceptanceEvidence): void {
  const authority = parseAcceptedCustodyAuthority("accepted_authority" in value ? value.accepted_authority : value);
  if (!sameAuthority(expected, authority)) throw new Error("Reopened accepted control authority differs from installed custody.");
  if (plan.ceremony_kind === "profile_loss_recovery") {
    if (!("accepted_authority" in value)) throw new Error("Recovery verification omitted supersession evidence.");
    requireExactObjectKeys(value, [
      "accepted_authority", "replacement_device_authoritative", "lost_device_superseded", "late_lost_device_evidence",
      "old_private_keys_restored", "old_sequence_continuity_restored", "old_reservations_restored"
    ], "root recovery acceptance evidence");
    if (value.replacement_device_authoritative !== true || value.lost_device_superseded !== true ||
        value.late_lost_device_evidence !== "superseded_control_branch" || value.old_private_keys_restored !== false ||
        value.old_sequence_continuity_restored !== false || value.old_reservations_restored !== false) {
      throw new Error("Recovery verification did not prove new-device authority and lost-device supersession.");
    }
  }
}

function completionMarker(journal: CustodyCeremonyJournal): CustodyCompletionMarker {
  if (journal.phase !== "portable_visible" || !journal.recovery_kit_sha256 || !journal.accepted_control_head_id) throw new Error("Completion marker requires portable authority and verified recovery evidence.");
  return Object.freeze({
    schema_version: HC2_CEREMONY_JOURNAL_VERSION,
    record_kind: "custody_completion_marker",
    ceremony_id: journal.ceremony_id,
    ceremony_kind: journal.ceremony_kind,
    project_id: journal.project_id,
    device_id: journal.device_id,
    root_key_id: journal.root_key_id,
    key_epoch_id: journal.key_epoch_id,
    recovery_kit_sha256: Uint8Array.from(journal.recovery_kit_sha256),
    accepted_control_head_id: journal.accepted_control_head_id,
    completion: "verified_local_ceremony"
  });
}

function publicBindingFromVault(vault: StoredDeviceVaultRecord): DeviceCustodyPublicBinding {
  return Object.freeze({
    project_id: vault.project_id, person_id: vault.person_id, device_id: vault.device_id, access_scope_id: vault.access_scope_id,
    generation: vault.generation, signing_key_id: vault.signing_key_id, signing_public_key_bytes: Uint8Array.from(vault.signing_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    recipient_key_id: vault.recipient_key_id, recipient_public_key_bytes: Uint8Array.from(vault.recipient_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    accepted_control_head_id: vault.accepted_control_head_id, offline_root_key_id: vault.offline_root_key_id,
    current_epoch_id: vault.current_epoch_id, current_epoch_commitment: vault.current_epoch_commitment,
    current_epoch_public_commitment_bytes: Uint8Array.from(vault.current_epoch_public_commitment_bytes)
  });
}

function withoutControl(value: DeviceCustodyPublicBinding): Omit<DeviceCustodyPublicBinding, "accepted_control_head_id"> {
  return Object.freeze({
    project_id: value.project_id, person_id: value.person_id, device_id: value.device_id, access_scope_id: value.access_scope_id,
    generation: value.generation, signing_key_id: value.signing_key_id,
    signing_public_key_bytes: Uint8Array.from(value.signing_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    recipient_key_id: value.recipient_key_id,
    recipient_public_key_bytes: Uint8Array.from(value.recipient_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    offline_root_key_id: value.offline_root_key_id, current_epoch_id: value.current_epoch_id,
    current_epoch_commitment: value.current_epoch_commitment,
    current_epoch_public_commitment_bytes: Uint8Array.from(value.current_epoch_public_commitment_bytes)
  });
}

function authorityFromVault(vault: StoredDeviceVaultRecord): AcceptedCustodyAuthority {
  return Object.freeze({
    project_id: vault.project_id, person_id: vault.person_id, device_id: vault.device_id, access_scope_id: vault.access_scope_id,
    signing_key_id: vault.signing_key_id, recipient_key_id: vault.recipient_key_id, accepted_control_head_id: vault.accepted_control_head_id,
    offline_root_key_id: vault.offline_root_key_id, key_epoch_id: vault.current_epoch_id, key_epoch_commitment: vault.current_epoch_commitment, device_status: "active"
  });
}

async function requireJournal(store: Hc2CustodyStore, plan: CustodyCeremonyPlan): Promise<CustodyCeremonyJournal> {
  const journal = await store.readCeremony(plan.project_id, plan.ceremony_id);
  if (!journal) throw new Error("Custody ceremony journal is missing.");
  return journal;
}

async function requireKit(sink: RecoveryKitSink, ceremonyId: string, digest: Uint8Array): Promise<Uint8Array> {
  const bytes = await sink.read(ceremonyId);
  if (!(bytes instanceof Uint8Array) || !sameBytes(await sha256(bytes), digest)) throw new Error("Recovery-kit bytes changed after mandatory verification.");
  return bytes;
}

async function inject(injector: Hc2CustodyCeremonyFailureInjector | undefined, cut: Hc2CustodyCeremonyFailureCut, operationId: string): Promise<void> {
  await injector?.inject(Object.freeze({ cut, operation_id: operationId }));
}

function lockResult<T>(value: Readonly<{ status: "completed"; value: T } | { status: "aborted" | "lock_failed" | "operation_failed"; reason: string }>): T | CustodyCeremonyFailureResult {
  if (value.status === "completed") return value.value;
  return Object.freeze({ status: value.status === "operation_failed" ? "failed" : value.status, reason: value.reason });
}

function failed(error: unknown): CustodyCeremonyFailureResult { return Object.freeze({ status: "failed", reason: safeErrorName(error) }); }
function safeErrorName(error: unknown): string { return typeof error === "object" && error !== null && "name" in error && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "custody_ceremony_failed"; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i]; return difference === 0; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameCutoffs(left: readonly DeviceSequenceCutoff[], right: readonly DeviceSequenceCutoff[]): boolean { return left.length === right.length && left.every((value, index) => value.device_id === right[index].device_id && value.maximum_accepted_semantic_sequence === right[index].maximum_accepted_semantic_sequence); }
function sameAuthority(left: AcceptedCustodyAuthority, right: AcceptedCustodyAuthority): boolean { return left.project_id === right.project_id && left.person_id === right.person_id && left.device_id === right.device_id && left.access_scope_id === right.access_scope_id && left.signing_key_id === right.signing_key_id && left.recipient_key_id === right.recipient_key_id && left.accepted_control_head_id === right.accepted_control_head_id && left.offline_root_key_id === right.offline_root_key_id && left.key_epoch_id === right.key_epoch_id && left.key_epoch_commitment === right.key_epoch_commitment; }
function requireExactObjectKeys(value: object, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(); const keys = [...expected].sort(); if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error(`${label} fields are invalid.`); }

import type {
  BootstrapCompleteMarker,
  BootstrapJournal,
  CollaborationBootstrapPlan,
  CurrentStateAdmissionPlan,
  DuplicateCollaborationBootstrapInput,
  FullHistoryCheckpointVerificationResult,
  LegacyIdentityAlias,
  NativeCollaborationBootstrapInput,
  NormalizedDuplicationPrivateState,
  NormalizedDuplicationSourceInventory,
  ProjectId
} from "../lib/collaboration/index.ts";

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type HasKey<T, TKey extends PropertyKey> = TKey extends keyof T ? true : false;
type IsAssignable<TLeft, TRight> = TLeft extends TRight ? true : false;

export type BootstrapTypeBoundaryAssertions = readonly [
  Assert<IsAssignable<CollaborationBootstrapPlan["authority"], "none">>,
  AssertFalse<IsAssignable<NativeCollaborationBootstrapInput, DuplicateCollaborationBootstrapInput>>,
  AssertFalse<IsAssignable<DuplicateCollaborationBootstrapInput, NativeCollaborationBootstrapInput>>,
  AssertFalse<IsAssignable<LegacyIdentityAlias, ProjectId>>,
  AssertFalse<HasKey<NormalizedDuplicationSourceInventory, "destination_project_id">>,
  Assert<HasKey<NormalizedDuplicationSourceInventory, "private_state">>,
  AssertFalse<HasKey<CollaborationBootstrapPlan, "private_state">>,
  AssertFalse<HasKey<CollaborationBootstrapPlan, "sign">>,
  AssertFalse<HasKey<CollaborationBootstrapPlan, "write">>,
  AssertFalse<HasKey<CurrentStateAdmissionPlan, "attestation">>,
  AssertFalse<HasKey<CurrentStateAdmissionPlan, "invitation">>,
  Assert<IsAssignable<BootstrapCompleteMarker["destination_status"], "complete_local_foundation">>,
  AssertFalse<IsAssignable<BootstrapJournal, BootstrapCompleteMarker>>,
  AssertFalse<IsAssignable<CurrentStateAdmissionPlan, Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>>>,
  Assert<HasKey<NormalizedDuplicationPrivateState, "absolute_paths">>
];

declare const alias: LegacyIdentityAlias;
declare const native: NativeCollaborationBootstrapInput;

function requiresProjectId(value: ProjectId): void { void value; }
function requiresDuplicate(value: DuplicateCollaborationBootstrapInput): void { void value; }

// @ts-expect-error Authority-free aliases can never act as collaboration IDs.
requiresProjectId(alias);

// @ts-expect-error Native and duplicate inputs are distinct construction modes.
requiresDuplicate(native);

export {};

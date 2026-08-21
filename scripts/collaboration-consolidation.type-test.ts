import type {
  AcknowledgementId,
  AcknowledgementRecord,
  CheckpointPreparationInput,
  CompositeProjectionRootInput,
  OnboardingBoundaryVerificationInput,
  PrepareAcknowledgementInput,
  PreparedAcknowledgementDraft,
  PreparedConsolidationCheckpoint,
  SemanticEventId,
  SnapshotVerificationInput
} from "../lib/collaboration/index.ts";

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type HasKey<T, TKey extends PropertyKey> = TKey extends keyof T ? true : false;
type IsAssignable<TLeft, TRight> = TLeft extends TRight ? true : false;

export type ConsolidationPurityContractAssertions = readonly [
  AssertFalse<HasKey<CompositeProjectionRootInput, "write">>,
  AssertFalse<HasKey<CompositeProjectionRootInput, "store">>,
  AssertFalse<HasKey<CompositeProjectionRootInput, "append_event">>,
  AssertFalse<HasKey<CheckpointPreparationInput, "sign">>,
  AssertFalse<HasKey<CheckpointPreparationInput, "append_event">>,
  AssertFalse<HasKey<CheckpointPreparationInput, "allocate_sequence">>,
  AssertFalse<HasKey<CheckpointPreparationInput, "put_snapshot">>,
  AssertFalse<HasKey<SnapshotVerificationInput, "authorize_onboarding">>,
  AssertFalse<HasKey<SnapshotVerificationInput, "verify_owner_admission">>,
  AssertFalse<HasKey<OnboardingBoundaryVerificationInput, "read_prior_history">>,
  AssertFalse<HasKey<OnboardingBoundaryVerificationInput, "read_prior_key">>,
  AssertFalse<HasKey<OnboardingBoundaryVerificationInput, "recover_prior_plaintext">>,
  AssertFalse<HasKey<PrepareAcknowledgementInput, "append_semantic_event">>,
  AssertFalse<IsAssignable<AcknowledgementId, SemanticEventId>>,
  Assert<IsAssignable<PreparedConsolidationCheckpoint["authority"], "none">>,
  Assert<IsAssignable<PreparedAcknowledgementDraft["authority"], "none">>,
  Assert<IsAssignable<AcknowledgementRecord["object_kind"], "acknowledgement">>
];

declare const acknowledgementId: AcknowledgementId;

function requiresSemanticEventId(value: SemanticEventId): void {
  void value;
}

// @ts-expect-error Acknowledgements are a separate stream, not semantic history.
requiresSemanticEventId(acknowledgementId);

export {};

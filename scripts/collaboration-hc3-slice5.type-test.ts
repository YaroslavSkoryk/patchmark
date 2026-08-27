import type {
  Hc3CapabilityOperationFailure,
  Hc3ProductCapabilityMatrix,
  Hc3ProductCapabilityState
} from "../lib/collaboration/hc3/index.ts";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type RequiredCapabilityStates =
  | "supported"
  | "unsupported"
  | "permission_required"
  | "permission_denied"
  | "temporarily_unavailable"
  | "lost_during_operation"
  | "incompatible_result"
  | "not_exercised";

type Slice5Assertions = [
  Assert<Equal<Hc3ProductCapabilityState, RequiredCapabilityStates>>,
  Assert<Equal<Hc3ProductCapabilityMatrix["authority"], "none">>,
  Assert<Equal<Hc3ProductCapabilityMatrix["permission_bearing_operations_invoked"], false>>,
  Assert<Equal<Hc3CapabilityOperationFailure["authority"], "none">>,
  Assert<Equal<Hc3CapabilityOperationFailure["automatic_retry"], false>>,
  Assert<Equal<Hc3CapabilityOperationFailure["prepared_artifact_preserved"], true>>
];

declare const assertions: Slice5Assertions;
void assertions;

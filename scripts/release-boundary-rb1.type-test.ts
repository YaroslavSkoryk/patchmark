import {
  productReleaseState,
  resolveCheckedInProductFeatureRelease,
  resolveProductFeatureRelease,
  type ProductFeatureName,
  type ProductFeatureReleaseResolution
} from "../lib/release/product-release-state.ts";
import type { CollaborationProductFeatureState } from "../lib/collaboration-shadow/feature-state.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

type HumanReleaseIsLiteralFalse = Expect<
  Equal<typeof productReleaseState.human_collaboration, false>
>;
type AgentReleaseIsLiteralFalse = Expect<
  Equal<typeof productReleaseState.agent_exchange, false>
>;
type FeatureNamesAreIndependent = Expect<
  Equal<ProductFeatureName, "human_collaboration" | "agent_exchange">
>;
type ResolutionsAreClosed = Expect<
  Equal<
    ProductFeatureReleaseResolution["mode"],
    "disabled" | "development_qualification" | "released"
  >
>;
type CollaborationProductModesAreClosed = Expect<
  Equal<
    CollaborationProductFeatureState["mode"],
    "disabled" | "development_shadow" | "released"
  >
>;

void (null as unknown as HumanReleaseIsLiteralFalse);
void (null as unknown as AgentReleaseIsLiteralFalse);
void (null as unknown as FeatureNamesAreIndependent);
void (null as unknown as ResolutionsAreClosed);
void (null as unknown as CollaborationProductModesAreClosed);

const human = resolveCheckedInProductFeatureRelease("human_collaboration", {
  runtime: "production",
  qualification_signal: undefined
});
const agent = resolveCheckedInProductFeatureRelease("agent_exchange", {
  runtime: "production",
  qualification_signal: undefined
});
const prospectiveAgent = resolveProductFeatureRelease({
  feature: "agent_exchange",
  release_state: true,
  environment: {
    runtime: "production",
    qualification_signal: undefined
  }
});

void human;
void agent;
void prospectiveAgent;

// @ts-expect-error checked-in release literals are immutable
productReleaseState.human_collaboration = true;
// @ts-expect-error feature names are a closed taxonomy
resolveCheckedInProductFeatureRelease("collaboration", {
  runtime: "production",
  qualification_signal: undefined
});
resolveCheckedInProductFeatureRelease("agent_exchange", {
  // @ts-expect-error runtime names are closed and cannot be supplied by artifacts
  runtime: "browser_storage",
  qualification_signal: undefined
});

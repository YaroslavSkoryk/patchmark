import type {
  CollaborationShadowDisabledSentinel,
  CollaborationShadowMutationReceipt,
  CollaborationShadowResult
} from "./contracts.ts";
import {
  getBuildCollaborationShadowFeatureState,
  resolveInjectedCollaborationProductFeatureState,
  type CollaborationProductFeatureState,
  type CollaborationShadowFeatureState
} from "./feature-state.ts";

export type {
  CollaborationShadowMutationKind,
  CollaborationShadowMutationReceipt,
  ShadowLegacyAnchor,
  ShadowLegacyDocument,
  ShadowLegacySharedState
} from "./contracts.ts";

export type CollaborationShadowReceiptFactory =
  () => CollaborationShadowMutationReceipt | Promise<CollaborationShadowMutationReceipt>;

export type CollaborationShadowHeavyModule = Readonly<{
  processDevelopmentShadowMutation: (
    value: unknown
  ) => Promise<CollaborationShadowResult>;
}>;

export type CollaborationShadowDispatch =
  | CollaborationShadowDisabledSentinel
  | Promise<CollaborationShadowResult>;

export type CollaborationProductQualificationModule = Readonly<{
  CollaborationQualificationWorkspace: unknown;
}>;

export type CollaborationProductQualificationDispatch =
  | CollaborationShadowDisabledSentinel
  | Promise<CollaborationProductQualificationModule>;

const disabledSentinel: CollaborationShadowDisabledSentinel = Object.freeze({
  mode: "disabled",
  outcome: "disabled"
});

export function runCollaborationShadowAfterLegacyCommit(
  factory: CollaborationShadowReceiptFactory
): CollaborationShadowDispatch {
  const featureState = getBuildCollaborationShadowFeatureState();
  if (featureState.mode === "disabled") return disabledSentinel;
  return loadAndDispatch(factory, () => import("./shadow-implementation.ts"));
}

export function getCollaborationProductQualificationState(
  injectedState: unknown
): CollaborationProductFeatureState {
  return resolveInjectedCollaborationProductFeatureState(injectedState);
}

export function loadCollaborationProductQualification(
  injectedState: unknown
): CollaborationProductQualificationDispatch {
  const featureState = resolveInjectedCollaborationProductFeatureState(injectedState);
  if (featureState.mode === "disabled") return disabledSentinel;
  return import("./product-qualification-loader.ts");
}

export function createCollaborationShadowEntrypoint(options: Readonly<{
  get_feature_state: () => CollaborationShadowFeatureState;
  load_heavy_module: () => Promise<CollaborationShadowHeavyModule>;
}>): (factory: CollaborationShadowReceiptFactory) => CollaborationShadowDispatch {
  return (factory) => {
    const featureState = options.get_feature_state();
    if (featureState.mode === "disabled") return disabledSentinel;
    return loadAndDispatch(factory, options.load_heavy_module);
  };
}

async function loadAndDispatch(
  factory: CollaborationShadowReceiptFactory,
  loadHeavyModule: () => Promise<CollaborationShadowHeavyModule>
): Promise<CollaborationShadowResult> {
  try {
    const implementation = await loadHeavyModule();
    return await implementation.processDevelopmentShadowMutation(await factory());
  } catch (error) {
    return Object.freeze({
      mode: "development_shadow" as const,
      outcome: "shadow_unavailable" as const,
      source_project_id: null,
      shadow_project_id: null,
      requires_rebootstrap: true,
      diagnostic: error instanceof Error ? error.message : "Shadow dispatch failed."
    });
  }
}

export function isCollaborationShadowDisabled(
  value: CollaborationShadowDispatch
): value is CollaborationShadowDisabledSentinel {
  return value === disabledSentinel;
}

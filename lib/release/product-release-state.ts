export const productFeatureNames = [
  "human_collaboration",
  "agent_exchange"
] as const;

export type ProductFeatureName = (typeof productFeatureNames)[number];

export type ProductReleaseStateDefinition = Readonly<
  Record<ProductFeatureName, boolean>
>;

/**
 * The sole production release authority for unfinished product features.
 * Changing either literal requires reviewed source, a new production build,
 * and the qualification required by that feature's release record.
 */
export const productReleaseState = Object.freeze({
  human_collaboration: false,
  agent_exchange: false
} as const satisfies ProductReleaseStateDefinition);

export const productFeatureRuntimeNames = [
  "development",
  "test",
  "production",
  "unknown"
] as const;

export type ProductFeatureRuntime =
  (typeof productFeatureRuntimeNames)[number];

export const developmentQualificationSignal =
  "development_qualification" as const;

export type ProductFeatureReleaseEnvironment = Readonly<{
  runtime: ProductFeatureRuntime;
  qualification_signal: unknown;
}>;

export type ProductFeatureReleaseResolution =
  | Readonly<{
      feature: ProductFeatureName;
      mode: "disabled";
      reason: "checked_in_release_disabled" | "invalid_release_input";
    }>
  | Readonly<{
      feature: ProductFeatureName;
      mode: "development_qualification";
      reason: "explicit_non_production_qualification";
    }>
  | Readonly<{
      feature: ProductFeatureName;
      mode: "released";
      reason: "reviewed_source_release";
    }>;

const acceptedEnvironmentKeys = Object.freeze([
  "runtime",
  "qualification_signal"
] as const);

export function resolveCheckedInProductFeatureRelease(
  feature: ProductFeatureName,
  environment: ProductFeatureReleaseEnvironment
): ProductFeatureReleaseResolution {
  return resolveProductFeatureRelease({
    feature,
    release_state: productReleaseState[feature],
    environment
  });
}

/** Test-only callers may inject a prospective literal to prove independence. */
export function resolveProductFeatureRelease(input: Readonly<{
  feature: ProductFeatureName;
  release_state: boolean;
  environment: ProductFeatureReleaseEnvironment;
}>): ProductFeatureReleaseResolution {
  const { environment, feature, release_state: releaseState } = input;
  const keys = environment && typeof environment === "object"
    ? Object.keys(environment)
    : [];
  const validEnvironment =
    environment !== null &&
    typeof environment === "object" &&
    keys.length === acceptedEnvironmentKeys.length &&
    keys.every((key) =>
      acceptedEnvironmentKeys.includes(
        key as (typeof acceptedEnvironmentKeys)[number]
      )
    ) &&
    productFeatureRuntimeNames.includes(environment.runtime) &&
    typeof releaseState === "boolean";

  if (!validEnvironment) {
    return disabled(feature, "invalid_release_input");
  }
  if (releaseState) {
    return Object.freeze({
      feature,
      mode: "released" as const,
      reason: "reviewed_source_release" as const
    });
  }
  if (
    (environment.runtime === "development" || environment.runtime === "test") &&
    environment.qualification_signal === developmentQualificationSignal
  ) {
    return Object.freeze({
      feature,
      mode: "development_qualification" as const,
      reason: "explicit_non_production_qualification" as const
    });
  }
  return disabled(feature, "checked_in_release_disabled");
}

function disabled(
  feature: ProductFeatureName,
  reason: "checked_in_release_disabled" | "invalid_release_input"
): ProductFeatureReleaseResolution {
  return Object.freeze({ feature, mode: "disabled" as const, reason });
}
